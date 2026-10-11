/**
 * #17 — leadworks outbound webhooks.
 *
 * A Webhook row is a caller-named address this server connects to. Three properties
 * hold it fixed:
 *
 *   1. the egress module's `assertAllowedTarget` runs on the stored URL, in the same
 *      block and immediately above the fetch — the "policy" arm the vendored
 *      egress-sites guard reads;
 *   2. every outbound request is signed with HMAC-SHA256 using the row's own secret,
 *      so a receiver can distinguish us from anyone who guesses the URL;
 *   3. the dispatcher is actually reached — POST /api/leads calls it after the row
 *      commits, because an unrouted sender is §8.44's "present but unused" in a new
 *      file, and the check-auth-drift NON_USE premise that just retired cannot come
 *      back.
 *
 * This is a source-reading guard, not a runtime test. The reason is the same as
 * route-auth's: what we are pinning is a shape (a check sits above a fetch, an
 * import reaches a call site), and shape rot looks like a passing runtime test with
 * a removed line. Mutants in §8.61's after-probe are the proof.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const sender = readFileSync(join(ROOT, "src/lib/webhooks.ts"), "utf8");
const leadsRoute = readFileSync(join(ROOT, "src/app/api/leads/route.ts"), "utf8");

describe("#17 sender module", () => {
  it("imports the egress policy and crypto for the signature", () => {
    assert.match(
      sender,
      /import\s*\{\s*assertAllowedTarget\s*\}\s*from\s*"\.\/egress"/,
      "sender must import assertAllowedTarget from the vendored ./egress, not re-decide the rule",
    );
    assert.match(
      sender,
      /import\s+crypto\s+from\s+"crypto"/,
      "sender must import node:crypto so the signature is HMAC, not a hash of nothing",
    );
  });

  it("filters by isActive and by event name", () => {
    assert.match(
      sender,
      /where:\s*\{\s*workspaceId,\s*isActive:\s*true\s*\}/,
      "inactive hooks must never be sent to",
    );
    assert.match(
      sender,
      /hook\.events\.split\(","\)[\s\S]{0,80}\.includes\(event\)/,
      "the row's `events` column is a comma-separated string; a dispatcher that treats it as one name misses every multi-event hook",
    );
  });

  it("runs assertAllowedTarget on the stored URL before the fetch", () => {
    // Both live inside `deliver`. Slice the file from that function's body so the
    // ordering assertion cannot be satisfied by an unrelated earlier use.
    const deliverStart = sender.indexOf("async function deliver");
    assert.notEqual(deliverStart, -1, "sender must define `deliver` (the per-hook worker)");
    const body = sender.slice(deliverStart);
    const guardAt = body.search(/await\s+assertAllowedTarget\s*\(/);
    const fetchAt = body.search(/await\s+fetch\s*\(/);
    assert.notEqual(guardAt, -1, "sender must call assertAllowedTarget with await (a floating promise would let the fetch run first)");
    assert.notEqual(fetchAt, -1, "sender must call fetch — this is the outbound delivery");
    assert.ok(guardAt < fetchAt, "the egress check must sit above the fetch in the same block");
    // The argument to the check is the stored URL, not a recomputed one.
    assert.match(
      body.slice(guardAt, fetchAt),
      /assertAllowedTarget\s*\(\s*rawUrl/,
      "the checked address must be the same one that reaches fetch, not a copy of it",
    );
  });

  it("signs the body with HMAC-SHA256 over the row's secret", () => {
    assert.match(
      sender,
      /createHmac\(\s*"sha256"\s*,\s*secret\s*\)[\s\S]{0,80}\.update\(\s*body\s*\)[\s\S]{0,80}\.digest\(\s*"hex"\s*\)/,
      "signature must be HMAC-SHA256 hex over the exact bytes of the JSON body, using the hook's own secret",
    );
    assert.match(
      sender,
      /"X-Leadworks-Signature"\s*:\s*signature/,
      "signature must be sent under a stable header name receivers can verify against",
    );
  });

  it("bounds each delivery with a timeout so a hung receiver cannot pin the caller", () => {
    assert.match(
      sender,
      /signal:\s*AbortSignal\.timeout\(\s*\d+\s*\)/,
      "the fetch must carry AbortSignal.timeout(...) — the dispatcher is awaited by an API route, so an unbounded delivery is an unbounded request",
    );
  });

  it("swallows per-hook failures so one bad webhook does not fail the API caller", () => {
    // `Promise.allSettled` is the outer arm; a `catch` per delivery is the inner one.
    assert.match(
      sender,
      /await\s+Promise\.allSettled\s*\(/,
      "dispatcher must use Promise.allSettled so a single failing hook cannot reject the caller",
    );
    assert.match(
      sender,
      /catch\s*\(\s*error\s*\)\s*\{[\s\S]{0,200}console\.error/,
      "the per-delivery catch must log; a silent catch is how an outage becomes invisible",
    );
  });
});

describe("#17 wire-up at POST /api/leads", () => {
  it("imports the dispatcher", () => {
    assert.match(
      leadsRoute,
      /import\s*\{\s*dispatchWebhookEvent\s*\}\s*from\s*"@\/lib\/webhooks"/,
      "the route must actually import the dispatcher — an unused sender is #44's present-but-unused premise in a new file",
    );
  });

  it("dispatches `lead.created` after the row commits", () => {
    // Byte offsets, not line numbers: `prisma.lead.create` must be awaited and its
    // result bound before the dispatch, so the payload reflects a real row.
    const createAt = leadsRoute.search(/const\s+lead\s*=\s*await\s+prisma\.lead\.create\s*\(/);
    const dispatchAt = leadsRoute.search(/await\s+dispatchWebhookEvent\s*\(\s*workspaceId,\s*"lead\.created"/);
    assert.notEqual(createAt, -1, "POST /api/leads must create the lead row before dispatching");
    assert.notEqual(dispatchAt, -1, "POST /api/leads must await dispatchWebhookEvent(workspaceId, \"lead.created\", ...)");
    assert.ok(createAt < dispatchAt, "the dispatch must sit after `prisma.lead.create` so a caller that sees `lead.created` sees a row that exists");
  });

  it("still returns 201 for the created lead", () => {
    assert.match(
      leadsRoute,
      /return\s+NextResponse\.json\(\s*lead,\s*\{\s*status:\s*201\s*\}\s*\)/,
      "the response shape is unchanged — webhooks are best-effort on top of a successful create, not a replacement for it",
    );
  });
});
