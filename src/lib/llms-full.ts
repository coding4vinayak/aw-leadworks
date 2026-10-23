/**
 * `llms-full.txt` — the deep-content companion to the shipped index.
 *
 * The hub's own AI-visibility tool scores this file type at 4 points, and the
 * hub serves one of its own. The product host now ships one too — built from
 * the sources that cannot lie:
 *
 *   · the shipped index (`public/llms.txt`) is carried verbatim — one fetch
 *     holds both; the copy can therefore never drift from it (a test holds
 *     the generated file against both sources at unit-test time)
 *   · the OpenAPI contract (`src/lib/openapi.ts`) is imported as data, so
 *     every operation carried here is an operation that answers — the same
 *     source the contract routes themselves serve
 *   · the version is `src/lib/version.ts` — the number on the landing page
 *
 * A sentence per API call is formed with the contract's own words: its
 * `summary`, and the door it declares (`auth`) said as the one sentence an
 * integrator needs. No page copy is invented here; the selling sentences come
 * from the index the team already reviewed, everything else is structure.
 *
 * Pure functions — the script (`scripts/build-llms-full.mts`) does the file
 * work and CI runs it with `--check`, so a drift fails the build with the
 * first changed section named.
 */

type OperationBits = {
  path: string;
  method: string;
  operation: {
    id: string;
    summary: string;
    auth?: "key" | "session" | "none" | "stripe";
  };
};

export type LlmsFullInput = {
  /** The shipped index, verbatim — the one thing a full file must carry. */
  index: string;
  version: string;
  /** The canonical base URL every reference is built against. */
  origin: string;
  operations: OperationBits[];
};

/** The contract's own auth vocabulary, as the one sentence an integrator needs. */
const AUTH_SENTENCE: Record<NonNullable<OperationBits["operation"]["auth"]>, string> = {
  none: "no key needed",
  key: "needs the workspace's `x-api-key` key",
  session: "the browser's signed-in session",
  stripe: "verified against Stripe's signature",
};

function authLine(auth: OperationBits["operation"]["auth"]): string {
  const words = auth ? AUTH_SENTENCE[auth] : undefined;
  return words ? ` — ${words}` : "";
}

/**
 * The file a fetch of `/llms-full.txt` serves, newest sections last so an
 * engine that reads the top half is still holding the whole index.
 */
export function buildLlmsFull({ index, version, origin, operations }: LlmsFullInput): string {
  const lines: string[] = [];

  lines.push("# LeadWorks — the deep-content companion");
  lines.push("");
  lines.push(
    `> The full-content file for AI assistants that want the whole substance in one ` +
      `fetch. Built for build v${version} — the version the landing page wears — from the ` +
      `shipped index and the API contract, so it cannot say more than the product does.`,
  );
  lines.push("");

  lines.push("## The index, verbatim");
  lines.push("");
  lines.push("The machine-readable index ships as its own file (`/llms.txt`); it is carried");
  lines.push("here so one fetch holds both:");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(index.trimEnd());
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push(`## The API contract — ${operations.length} operations`);
  lines.push("");
  lines.push(
    `The same document \`${origin}/openapi.json\` serves (OpenAPI 3.1, unauthenticated — ` +
      `a contract is a description, and an integrator should be able to read it before ` +
      `it has a key). Every line below is an operation the routes answer:`,
  );
  lines.push("");
  for (const { path, method, operation } of operations) {
    lines.push(`- \`${method.toUpperCase()} ${path}\` — ${operation.summary}${authLine(operation.auth)}`);
  }
  lines.push("");

  lines.push("## Machine-readable");
  lines.push("");
  lines.push(`- The index: ${origin}/llms.txt`);
  lines.push(`- The contract: ${origin}/openapi.json (and \`${origin}/api/openapi\`)`);
  lines.push(`- This file: ${origin}/llms-full.txt`);
  lines.push("");

  return lines.join("\n");
}