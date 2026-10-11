import { getSession } from "./session";
import { prisma } from "./db";

/**
 * Who is asking an AI route, and on whose behalf.
 *
 * The AI endpoints are the only management routes a *browser* needs, and a
 * browser holds a session cookie rather than a bearer key. Requiring a key here
 * would mean the reply drafter and the metric explainer are reachable only by
 * someone who had already found the key API — which is how a shipped feature
 * ends up with no users.
 *
 * So an actor is either a signed-in session or an API key, and in both cases the
 * workspace comes from the credential, never from the request body. A body that
 * claims a different workspace is refused rather than honoured, so this stays a
 * tenant boundary and not a convenience. Refused includes *unknowable*: a claim
 * that is not a string names no workspace at all, and is not quietly read as one.
 */
export interface AiActor {
  workspaceId: string;
  via: "session" | "key";
}

/** A caller the route must not serve; `status` is the answer its wrapper renders. */
export class AiAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/**
 * What a caller *said* about which workspace this is, read as one of four things.
 *
 * Pure by construction: it touches no session, no key and no database, which is
 * the only reason it can be tested offline in all six apps (`n25-offline.mts`
 * imports a vendored copy under `tsx` with no request context and gets the
 * module's exports). The test lives at `shared/tests/ai-claim.test.ts` and is
 * vendored with this file.
 *
 * The rule is abetanalytics's, adopted. It was the only app that refused a claim
 * for being the wrong *type* rather than the wrong value, and measured across the
 * three behaviours on 2026-10-04 (`/tmp/abectorial/n25-{leadgenius,abetflow,
 * abetanalytics}-before.txt`, eleven claim shapes each, key path, against a copy
 * of each app's dev.db) its answer was the only one that never told a lie:
 *
 *   shape               leadgenius          abetflow            abetanalytics
 *   42 / {} / true      403 "not belong"    403 "not belong"    400 "must be text"
 *   0 / false           403 "not belong"    200 own workspace   400 "must be text"
 *   ["<own id>"]        200 own workspace   403 "not belong"    400 "must be text"
 *
 * leadgenius coerces (`String(claim)` at its call site), which is where `0` and
 * `false` became 403 there while abetflow honoured them, and where an array
 * holding the caller's own id became a 200. abetflow's truthiness gate
 * silently honours the key's workspace for a caller who asked for another one,
 * which is the failure this function exists to close: after it, `0` and `false`
 * are refused in every app, and no array or object is ever read as an id.
 *
 * `""` is *absent*, not refused. It is text, so "workspaceId must be text." would
 * be a false statement about the request, and an empty field is what a cleared
 * form control sends. This matches the measured abetanalytics answer for `""`
 * (409 — the route ran), so adopting its rule changes nothing there.
 */
export type ClaimVerdict = "absent" | "own" | "foreign" | "not-text";

export function classifyWorkspaceClaim(claim: unknown, workspaceId: string): ClaimVerdict {
  if (claim === undefined || claim === null || claim === "") return "absent";
  if (typeof claim !== "string") return "not-text";
  return claim === workspaceId ? "own" : "foreign";
}

/**
 * Refuse a claim that is not the credential's own workspace.
 *
 * Same verdict, different answer, because the two credentials are different
 * audiences. A bearer key is being told about its own scope, so naming the field
 * is right and the status is about the request. A signed-in browser is being told
 * "we do not show you that", and the status stays the 401 the module has always
 * used for a session whose claim does not match: telling a signed-in caller that
 * a workspace exists but is not theirs is a small confirmation, which is why the
 * message is `Not found.` and not a 403 with detail.
 *
 * Both paths check *after* the credential resolves, so an invalid key is answered
 * about the key (measured 401 "Invalid or revoked API key." in all three apps,
 * with a foreign claim in the same body).
 */
export function enforceWorkspaceClaim(
  claim: unknown,
  workspaceId: string,
  via: AiActor["via"],
): void {
  switch (classifyWorkspaceClaim(claim, workspaceId)) {
    case "absent":
    case "own":
      return;
    case "not-text":
      throw new AiAuthError("workspaceId must be text.", 400);
    case "foreign":
      throw new AiAuthError(
        via === "session" ? "Not found." : "workspaceId does not belong to this API key.",
        via === "session" ? 401 : 403,
      );
  }
}

export interface AiActorOptions {
  /**
   * A workspace id taken from the body, checked against the credential. Typed
   * `unknown` because the caller reads it out of a parsed body before validating
   * it: an unvalidated field is not text because an annotation said so, and what
   * arrives may be a number, an array or an object. Comparing one to the
   * credential's workspace is well-defined; assuming it is a string is not.
   *
   * Hand the parsed value over as it came out of the body. Coercing it first —
   * which is what leadgenius's `String(claim)` did, and what turned `false` into
   * the text `"false"` and `["<own id>"]` into the id itself —
   * destroys exactly the information this check needs, and the route is the worse
   * place to decide what a wrong type means.
   *
   * The check happens here — in the vendored classifier — and every app's
   * `authedWorkspaceId` reaches it through `classifyWorkspaceClaim`. That is #43's
   * closure: measured 2026-10-04, 59 call sites passed a claim to
   * `authedWorkspaceId`, 29 of them `searchParams.get("workspaceId")` (which cannot
   * return a non-text value) and 30 not: 29 a JSON body field, one a dynamic path
   * segment. Before #43 those 30 decided the answer in each app's own `apikeys.ts`,
   * which is per-app on purpose (its prisma model names, its `mintApiKey`, its
   * `ApiKeyError` class). Now they decide in the classifier and the app's own error
   * class, and the guard test vendored from `shared/tests/apikeys-claim.test.ts`
   * fails any app that stops reaching through.
   */
  claimedWorkspaceId?: unknown;
  /**
   * The app's existing API-key check, called only when there is no session.
   * Returns the workspace the key belongs to. Pass no claim to it: this module
   * checks the claim, so the app's own version of the rule cannot answer first.
   */
  keyWorkspaceId: () => Promise<string>;
}

export async function resolveAiActor(request: Request, options: AiActorOptions): Promise<AiActor> {
  const session = await getSession();
  if (session) {
    enforceWorkspaceClaim(options.claimedWorkspaceId, session.workspaceId, "session");
    return { workspaceId: session.workspaceId, via: "session" };
  }

  const workspaceId = await options.keyWorkspaceId();
  enforceWorkspaceClaim(options.claimedWorkspaceId, workspaceId, "key");
  return { workspaceId, via: "key" };
}

/**
 * Load a row that belongs to the actor's workspace, or return null.
 *
 * Scoping the query itself — rather than fetching by id and asserting
 * afterwards — means a row in another tenant is simply not found, so there is no
 * window where foreign data is in hand before a check runs.
 */
export async function loadOwned<T extends { workspaceId: string }>(
  find: (workspaceId: string) => Promise<T | null>,
  actor: AiActor,
): Promise<T | null> {
  return find(actor.workspaceId);
}

/** Whether any AI route has a usable provider, for the dashboard's own copy. */
export async function aiConfiguredForWorkspace(workspaceId: string): Promise<boolean> {
  const count = await prisma.apiKey.count({ where: { workspaceId, revokedAt: null } });
  return count > 0;
}

/**
 * Render an actor failure as the status it carries.
 *
 * Each app's `withAuth` only knows about its own `ApiKeyError`, so an
 * `AiAuthError` thrown from here would otherwise escape as a 500 — turning a
 * rejected credential into a server fault, and telling an attacker the
 * difference between "no key" and "wrong workspace".
 *
 * The body is `{ error: message }` at that status, which is byte-identical to
 * what each app's `withAuth` already renders for its own `ApiKeyError`. That is
 * deliberate: the refusals this module raises used to come from inside
 * `authedWorkspaceId`, and moving them here must not change a single byte a
 * caller can see. Measured by the after-probe against the three before-states.
 *
 * Wrap it inside the app's own wrapper: `withAuth(withAiAuth(handler))`.
 */
export function withAiAuth<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof AiAuthError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  };
}
