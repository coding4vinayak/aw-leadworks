// #113 — the checkout route's refusals, pinned offline.
//
// This route makes a Stripe subscription, so it is the one place in the billing
// path where a missing check costs money *and* goodwill. What it can be tested
// for without a Stripe account is the ordering: every reason not to proceed has
// to be decided before the session exists, because afterwards there is a real
// subscription on a real customer and nothing here can undo it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const checkout = source("../../src/app/api/billing/checkout/route.ts");
const stripeModule = source("../../src/lib/stripe.ts");

const NO_PLAN = "{ status: 409 }";
const BUY = "await createCheckoutSession(";

describe("the refusals are decided before the money", () => {
  it("happen in the order the buyer needs them", () => {
    const steps = [
      ['return NextResponse.json({ error: "Sign in required." }, { status: 401 })'],
      ["priceId must be one of"],
      ["returnUrl must be a page on this site"],
      [NO_PLAN],
      [BUY],
    ];
    let at = -1;
    for (const [needle] of steps) {
      const found = checkout.indexOf(needle);
      assert.ok(found > at, `nothing after this may be decided first: ${needle}`);
      at = found;
    }
  });

  it("answers the workspace from its own session, never from the request", () => {
    assert.match(checkout, /const session = await getSession\(\);/);
    assert.doesNotMatch(checkout, /body as \{[^}]*workspaceId/, "a workspaceId in the body is somebody else's tenant");
  });
});

describe("one subscription per workspace", () => {
  it("asks the row this app trusts, not Stripe", () => {
    assert.match(checkout, /prisma\.subscription\.findUnique\(\{\s*where: \{ workspaceId: session\.workspaceId \}/);
    assert.doesNotMatch(checkout, /subscriptions\.list/, "an API call here decides nothing that the database does not already know");
  });

  it("refuses every status that is still a live subscription", () => {
    assert.match(checkout, /SUBSCRIPTION_STATUS_OPEN as readonly string\[\]\)\.includes\(current\.status\)/);
    assert.doesNotMatch(checkout, /\[\s*"trialing"/, "the set is named once, in lib/stripe.ts");
    // The access set is unchanged — unpaid is a live subscription, not access
    // — and the refusal set is it plus the status dunning ends in, whose open
    // invoice the portal settles.
    assert.match(stripeModule, /export const SUBSCRIPTION_STATUS_ACTIVE = \["trialing", "active", "past_due"\] as const;/);
    assert.match(stripeModule, /export const SUBSCRIPTION_STATUS_OPEN = \[\.\.\.SUBSCRIPTION_STATUS_ACTIVE, "unpaid"\] as const;/);
    // `incomplete` stays allowed on purpose: it never charged, Stripe expires
    // it on its own, and starting over is how a declined card tries again.
    assert.doesNotMatch(stripeModule, /SUBSCRIPTION_STATUS_OPEN = \[[^\]]*"incomplete"/);
  });

  it("hands back the session already open instead of minting a twin", () => {
    // A double-clicked button and the same page in two tabs are one intent,
    // so the second press gets the first press's session — not a second one
    // that could be completed as a second subscription.
    assert.match(stripeModule, /checkout\.sessions\.list\(\{ customer: customerId, status: "open", limit: 10 \}\)/);
    assert.match(stripeModule, /s\.metadata\?\.workspaceId === workspaceId/);
    assert.match(stripeModule, /s\.metadata\?\.priceId === priceId/);
    // A session open on the other price is expired rather than left behind.
    assert.match(stripeModule, /checkout\.sessions\.expire\(s\.id\)/);
    // Stamped, so the next press can recognise its own session.
    assert.match(stripeModule, /metadata: \{ workspaceId, priceId \}/);
  });

  it("shares one idempotency key across clicks that race the lookup", () => {
    // Two requests in the same ten seconds carry one key, so Stripe answers
    // the second with the first's session instead of making another.
    assert.match(
      stripeModule,
      /idempotencyKey: `checkout:\$\{workspaceId\}:\$\{priceId\}:\$\{Math\.floor\(Date\.now\(\) \/ 10_000\)\}`/,
    );
  });

  it("returns before it can make a customer or a subscription", () => {
    // `ensureCustomer` runs inside createCheckoutSession. Saying no first means
    // a workspace that already pays does not acquire a second of either.
    assert.ok(checkout.indexOf(NO_PLAN) < checkout.indexOf(BUY));
  });

  it("says where to go instead, in the same breath as the refusal", () => {
    assert.match(checkout, /billing portal/);
    assert.match(checkout, /second subscription, and a second invoice/);
  });

  it("keeps the status it refused in the message", () => {
    // "already on a plan" is a different conversation for a trial than for a
    // past-due subscription, and the buyer knows which one they are in.
    assert.match(checkout, /`This workspace is already on a \$\{current\.status\} plan\./);
  });
});
