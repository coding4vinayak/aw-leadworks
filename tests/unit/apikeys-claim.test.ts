// Every app that owns an apikeys.ts must reach the claim rule through ./ai-actor.
//
// Vendored by shared/sync-guards.sh, the only thing allowed to write this file's
// per-app copies. abetapi has no `src/lib/apikeys.ts` and skips every assertion;
// the other five run them.
//
// What is guarded is #43's fix: each app's `authedWorkspaceId` used to decide the
// claim itself, and five apps picked five answers for the same request. abetanalytics
// checked `typeof === "string"` and refused non-text at 400; the other four used a
// bare truthiness gate — `if (claimed && claimed !== workspaceId)` — which fails open
// on `0`, `false`, `null` and `""` (measured in §8.24's before-probe: abetflow returned
// the key's own workspace for a body that asked for `0`). Now every app delegates to
// `classifyWorkspaceClaim` from the vendored `./ai-actor`, which turns those
// behaviours into one four-way verdict.
//
// The rule is a function; the wiring is `authedWorkspaceId`. A future round could
// keep the import and revert the body to a truthiness gate, and the vendored
// `ai-actor.ts` copy would go byte-identical while nothing used it. That is the
// exact rot #44 pinned for auth. So beyond "still imports", this file asserts the
// body shape: the switch on the verdict, and the two statuses the family agreed on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const apikeysPath = join(ROOT, "src/lib/apikeys.ts");
const hasApikeys = existsSync(apikeysPath);

// abetapi has no apikeys.ts. Its `resolveAiActor` route (#48) already reaches the
// same rule directly, so the app still proves the delegation — through a different
// file. The skip is honest and named, not silent.
const suite = hasApikeys ? describe : describe.skip;
const apikeys = hasApikeys ? readFileSync(apikeysPath, "utf8") : "";

suite("apikeys.ts delegates the workspaceId claim rule", () => {
  it("imports the classifier from the vendored ./ai-actor", () => {
    assert.match(apikeys, /import\s*\{[^}]*classifyWorkspaceClaim[^}]*\}\s*from\s*"\.\/ai-actor"/,
      "apikeys.ts must read classifyWorkspaceClaim, not re-decide the verdict itself");
  });

  it("authedWorkspaceId switches on the classifier's verdict", () => {
    // Locate the function body, then look inside it, so a stray `classifyWorkspaceClaim`
    // elsewhere in the module (a re-export or a comment) does not pass this arm.
    const match = /export async function authedWorkspaceId\([^)]*\)\s*:\s*Promise<string>\s*\{([\s\S]*?)\n\}/.exec(apikeys);
    assert.ok(match, "authedWorkspaceId is defined in this module");
    const body = match[1];
    assert.match(body, /classifyWorkspaceClaim\(\s*claimed,\s*workspaceId\s*\)/,
      "the classifier decides the verdict — no truthiness gate, no local type check");
    // The four verdicts all appear, so the switch cannot be collapsed to a two-way
    // if/else that reads only "own" and one other case.
    for (const verdict of ["absent", "own", "not-text", "foreign"]) {
      assert.match(body, new RegExp(`case\\s+"${verdict}"`), `verdict "${verdict}" is handled`);
    }
    assert.doesNotMatch(body, /if\s*\(\s*claimed\s*&&/,
      "#43's defect was the truthiness gate — a claim of `0`, `false` or `\"\"` reached the key's own workspace");
  });

  it("answers a not-text claim at 400, naming the field", () => {
    const match = /export async function authedWorkspaceId\([^)]*\)\s*:\s*Promise<string>\s*\{([\s\S]*?)\n\}/.exec(apikeys)!;
    assert.match(match[1], /case "not-text":[\s\S]{0,200}throw new ApiKeyError\("workspaceId must be text\.", 400\)/,
      "a body that handed a number, array or object is a request error, not a policy refusal");
  });

  it("answers a foreign claim at 403, naming the API key", () => {
    const match = /export async function authedWorkspaceId\([^)]*\)\s*:\s*Promise<string>\s*\{([\s\S]*?)\n\}/.exec(apikeys)!;
    assert.match(match[1], /case "foreign":[\s\S]{0,200}throw new ApiKeyError\("workspaceId does not belong to this API key\.", 403\)/,
      "the claim was text and simply not this key's workspace — the 403 stays the family's answer");
  });

  it("widens authedWorkspaceId's claim type to unknown in every app", () => {
    // leadgenius was the last holdout with `claimed?: string | null`, which made a
    // non-string claim unreachable at the TypeScript surface but still possible at
    // runtime via `body.workspaceId` on a JSON route. `unknown` is the honest type:
    // the value is whatever came out of the parsed body, and the classifier decides.
    const sig = /export async function authedWorkspaceId\(\s*request: Request,\s*claimed\?:\s*([^\s,)]+)/.exec(apikeys);
    assert.ok(sig, "authedWorkspaceId is declared with (request, claimed?)");
    assert.equal(sig![1], "unknown", `claimed's type must be unknown, not ${sig![1]}`);
  });
});
