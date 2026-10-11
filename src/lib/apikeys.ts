import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { classifyWorkspaceClaim } from "./ai-actor";

/** Key prefix for this product, e.g. "lg_live_". Visible in the string itself. */
export const KEY_PREFIX = "lw_live_";

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Mint a key. The plaintext is returned once and never persisted. */
export function generateApiKey(): { plaintext: string; hashedKey: string; prefix: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { plaintext, hashedKey: hashKey(plaintext), prefix: plaintext.slice(0, KEY_PREFIX.length + 6) };
}

export class ApiKeyError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

function extractToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || undefined;
  const alt = request.headers.get("x-api-key");
  if (alt?.trim()) return alt.trim();
  return undefined;
}

export interface AuthedKey {
  workspaceId: string;
  keyId: string;
}

/**
 * Resolve the calling workspace from its API key. Lookup is by hash, so a
 * database leak does not hand over working keys. Throws ApiKeyError (401).
 */
export async function requireApiKey(request: Request): Promise<AuthedKey> {
  const token = extractToken(request);
  if (!token) throw new ApiKeyError("Missing API key. Send 'Authorization: Bearer <key>'.");

  const record = await prisma.apiKey.findUnique({ where: { hashedKey: hashKey(token) } });
  if (!record || record.revokedAt) throw new ApiKeyError("Invalid or revoked API key.");

  const expected = Buffer.from(record.hashedKey);
  const actual = Buffer.from(hashKey(token));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApiKeyError("Invalid API key.");
  }

  // Fire-and-forget: awaiting this touch would put every authenticated request
  // behind SQLite's single-writer lock. A missed timestamp is harmless.
  prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { workspaceId: record.workspaceId, keyId: record.id };
}

/**
 * Authenticate AND bind the claimed workspace. `claimed` is `unknown` because
 * every route that calls this reads the field out of a body it has not validated
 * yet; the vendored classifier in ./ai-actor decides the four verdicts (absent,
 * own, foreign, not-text) that #43 found each app had decided differently.
 * ApiKeyError stays per-app so a caller's catch keeps working, and the status
 * on the way out is 400 for a non-text claim, 403 for a foreign one.
 */
export async function authedWorkspaceId(request: Request, claimed?: unknown): Promise<string> {
  const { workspaceId } = await requireApiKey(request);
  switch (classifyWorkspaceClaim(claimed, workspaceId)) {
    case "absent":
    case "own":
      return workspaceId;
    case "not-text":
      throw new ApiKeyError("workspaceId must be text.", 400);
    case "foreign":
      throw new ApiKeyError("workspaceId does not belong to this API key.", 403);
  }
}

/** Assert a loaded row belongs to the calling key's workspace. Throws 403/404. */
export async function assertOwns(request: Request, rowWorkspaceId: string | null | undefined): Promise<string> {
  const { workspaceId } = await requireApiKey(request);
  if (!rowWorkspaceId || rowWorkspaceId !== workspaceId) {
    throw new ApiKeyError("Not found.", 404);
  }
  return workspaceId;
}

/** Mint + persist a key for a workspace. Plaintext returned once. */
export async function mintApiKey(workspaceId: string, name: string) {
  const { plaintext, hashedKey, prefix } = generateApiKey();
  const row = await prisma.apiKey.create({ data: { workspaceId, name, hashedKey, prefix } });
  return { id: row.id, plaintext, prefix };
}

/**
 * A unique violation is a known state, not a server fault, and it must never
 * leave as 5xx: 5xx is the one status a correct client retries, so "this lead
 * already exists" would become a retry storm against an error that was never
 * transient. Detection is structural (error name + code) rather than an
 * instanceof on the generated client, so the unit suite can cover it without
 * constructing a generated artifact or reaching a database.
 */
export function conflictFor(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof Error) || !error.name.startsWith("PrismaClient")) return null;
  if ((error as { code?: unknown }).code !== "P2002") return null;

  const meta = (error as { meta?: { modelName?: unknown; target?: unknown } }).meta ?? {};
  const model = typeof meta.modelName === "string" ? meta.modelName : "record";
  const raw = Array.isArray(meta.target) ? meta.target : typeof meta.target === "string" ? meta.target.split(/[\s,]+/) : [];
  const fields = raw.filter((f): f is string => typeof f === "string" && f.length > 0);
  // workspaceId is the tenant the caller already authenticated as: naming it
  // would describe the scope of the constraint rather than what collided.
  const shown = fields.filter((f) => f !== "workspaceId");
  const list = (shown.length ? shown : fields).join(" + ");
  return {
    status: 409,
    body: {
      error: list ? `A ${model} with this ${list} already exists in this workspace.` : `That ${model} already exists in this workspace.`,
      conflict: { fields: shown.length ? shown : fields },
    },
  };
}

/**
 * Error boundary, NOT an authentication check. The name is the one thing this
 * helper cannot be trusted for: it turns an ApiKeyError or a P2002 thrown
 * *inside* the handler into a response, and if the handler never calls
 * requireApiKey / authedWorkspaceId / assertOwns / getSession, nothing here
 * stops an anonymous caller. Two routes were anonymous for exactly that reason
 * (leadworks GET /api/webhooks, abetagent GET /api/agents/[id]/runs), and
 * tests/unit/route-auth.test.ts now fails if another one is added.
 */
export function withAuth<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiKeyError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      const conflict = conflictFor(error);
      if (conflict) return Response.json(conflict.body, { status: conflict.status });
      throw error;
    }
  };
}
