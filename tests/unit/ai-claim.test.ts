// The `workspaceId` claim rule, asserted offline in all six apps.
//
// Vendored from shared/tests/ai-claim.test.ts by shared/sync-guards.sh, the only
// thing allowed to write this file's per-app copies. It tests a pure function, so
// it needs no server, no key and no database — the proof of that is that this file
// runs under `tsx --test` at all, since `src/lib/ai-actor.ts` imports
// `next/headers` through `./session` and nothing here ever reaches that call.
//
// What is under test is the *rule*, not the HTTP wrapper around it: the three
// behaviours this replaced were measured over HTTP
// (`/tmp/abectorial/n25-*-before.txt`), and the after-probe re-measures them. A
// unit test here is what keeps the six vendored copies from drifting back apart
// silently, which is the failure mode #43 was opened for.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AiAuthError,
  classifyWorkspaceClaim,
  enforceWorkspaceClaim,
  withAiAuth,
} from "../../src/lib/ai-actor";

const OWN = "ws-own-workspace";
const OTHER = "ws-another-tenant";

/**
 * `assert.throws` returns nothing, and the interesting part of these refusals is
 * the status and body text on the error object, so the throw is captured instead
 * of merely being witnessed.
 */
function expectThrow(run: () => void): AiAuthError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AiAuthError, `expected an AiAuthError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a throw");
}

describe("classifyWorkspaceClaim", () => {
  it("treats nothing-said, null and the empty field as no claim at all", () => {
    for (const claim of [undefined, null, ""]) {
      assert.equal(classifyWorkspaceClaim(claim, OWN), "absent", JSON.stringify(claim));
    }
  });

  it("matches a text claim against the credential's workspace", () => {
    assert.equal(classifyWorkspaceClaim(OWN, OWN), "own");
    assert.equal(classifyWorkspaceClaim(OTHER, OWN), "foreign");
    // A string that merely *contains* the id is not the id.
    assert.equal(classifyWorkspaceClaim(`${OWN} `, OWN), "foreign");
  });

  it("refuses every non-text claim, including the ones that were once honoured", () => {
    // `0` and `false` were a 200 in abetflow's before-state: the check there was
    // `if (claimed && claimed !== workspaceId)`, and a falsy claim fell through it
    // as though nothing had been said.
    const values: unknown[] = [42, 0, -0, false, true, NaN, {}, [], [OWN], [OWN, OTHER], [42]];
    for (const claim of values) {
      assert.equal(classifyWorkspaceClaim(claim, OWN), "not-text", String(claim));
    }
  });

  it("does not let an array holding the caller's own id read as a claim it made", () => {
    // leadgenius coerced first (`String(claim)`), and that coercion is the whole
    // trick: a one-element array stringifies to its element, so `[OWN]` became the
    // caller's own id and the request succeeded. The comparison was never the
    // problem — `String()` is what turned "an array" into "a workspace".
    assert.equal(classifyWorkspaceClaim([OWN], OWN), "not-text");
    assert.equal(String([OWN]), OWN);
    assert.notEqual([OWN] as unknown, OWN);
  });
});

describe("enforceWorkspaceClaim", () => {
  it("lets an absent or own claim pass on both paths", () => {
    for (const via of ["session", "key"] as const) {
      for (const claim of [undefined, null, "", OWN]) {
        assert.doesNotThrow(() => enforceWorkspaceClaim(claim, OWN, via));
      }
    }
  });

  it("answers a type failure with a 400 naming the field, on both paths", () => {
    for (const via of ["session", "key"] as const) {
      for (const claim of [42, 0, false, {}, [OWN]]) {
        const error = expectThrow(() => enforceWorkspaceClaim(claim, OWN, via));
        assert.equal(error.status, 400, `${via} ${String(claim)}`);
        assert.equal(error.message, "workspaceId must be text.");
      }
    }
  });

  it("answers a foreign claim with the credential's own refusal", () => {
    const key = expectThrow(() => enforceWorkspaceClaim(OTHER, OWN, "key"));
    assert.equal(key.status, 403);
    // Verbatim what each app's `authedWorkspaceId` threw before this moved here —
    // the byte a caller sees must not change when the decision changes files.
    assert.equal(key.message, "workspaceId does not belong to this API key.");

    const session = expectThrow(() => enforceWorkspaceClaim(OTHER, OWN, "session"));
    assert.equal(session.status, 401);
    // Not "not yours": a signed-in caller is not told that the workspace exists.
    assert.equal(session.message, "Not found.");
  });
});

describe("AiAuthError", () => {
  it("is a 401 when no status is given, and carries the status it is given", () => {
    assert.equal(new AiAuthError("nope").status, 401);
    assert.equal(new AiAuthError("nope", 403).status, 403);
  });
});

describe("withAiAuth", () => {
  it("renders the carried status as { error }, the shape the apps already return", async () => {
    const handler = withAiAuth(async () => {
      throw new AiAuthError("workspaceId must be text.", 400);
    });
    const response = await handler();
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "workspaceId must be text." });
  });

  it("lets a non-auth failure through untouched", async () => {
    const handler = withAiAuth(async () => {
      throw new Error("the model is down");
    });
    await assert.rejects(() => handler(), /the model is down/);
  });
});
