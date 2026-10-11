// Unit tests for Stripe webhook verification: offline, no network, no DB.
// The signature check is the security boundary (anyone can POST to the
// endpoint), so it gets its own tests. Run: npm run test:unit
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { sameOriginReturnUrl, verifyWebhook } from "../../src/lib/stripe";

const SECRET = "whsec_test_secret_for_unit_tests_only";

before(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

after(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

function signedHeader(payload: string, secret: string = SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe("verifyWebhook", () => {
  it("accepts a properly signed payload", () => {
    const payload = JSON.stringify({ id: "evt_test", object: "event" });
    const event = verifyWebhook(payload, signedHeader(payload));
    assert.equal(event.id, "evt_test");
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_test", object: "event" });
    const header = signedHeader(payload);
    assert.throws(() => verifyWebhook(payload + " ", header), /signature/i);
  });

  it("rejects a foreign secret", () => {
    const payload = JSON.stringify({ id: "evt_test", object: "event" });
    const header = signedHeader(payload, "whsec_attacker_secret");
    assert.throws(() => verifyWebhook(payload, header), /signature/i);
  });

  it("rejects a missing signature", () => {
    assert.throws(() => verifyWebhook("{}", null), /signature/i);
  });
});

// A billing return_url is where Stripe sends the customer after they have typed
// card details, so an unchecked one is a redirect off the payment page to any
// site the caller names. The billing routes also stopped taking workspaceId from
// the query string — it now comes from the signed-in session — which is the part
// that needs a browser cookie to test, so the pure half is pinned here.
describe("sameOriginReturnUrl", () => {
  const ORIGIN = "http://127.0.0.1:3300";

  it("accepts a page on this app", () => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    assert.equal(sameOriginReturnUrl(ORIGIN + "/settings/billing"), ORIGIN + "/settings/billing");
  });

  it("adds the trailing slash rather than dropping the path", () => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    assert.equal(sameOriginReturnUrl(ORIGIN), ORIGIN + "/");
  });

  it("rejects another site", () => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    assert.equal(sameOriginReturnUrl("https://billing.example.com/steal"), null);
  });

  it("rejects a same-prefix lookalike", () => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    assert.equal(sameOriginReturnUrl(ORIGIN + ".evil.test/"), null);
  });

  it("rejects javascript: and a non-URL string", () => {
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    assert.equal(sameOriginReturnUrl("javascript:alert(1)"), null);
    assert.equal(sameOriginReturnUrl("/settings/billing"), null);
    assert.equal(sameOriginReturnUrl(undefined), null);
    assert.equal(sameOriginReturnUrl(42), null);
  });

  it("fails closed when the app origin is not configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    assert.equal(sameOriginReturnUrl(ORIGIN + "/settings/billing"), null);
  });
});
