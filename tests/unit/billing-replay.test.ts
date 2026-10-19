// #115 — replayed and out-of-order Stripe events, pinned offline.
//
// Stripe delivers webhooks at least once and in no promised order. Two claims
// guard every handler because of it: an event is claimed by its id before it
// is processed, so a replay is answered `duplicate` instead of re-firing the
// receipt, the dunning mail and the cancellation pair; and a subscription row
// carries the newest event time it has applied, so an older snapshot that
// arrives late cannot drag a paying buyer back to `trialing` or `past_due`.
// What can only be proven with a database and Stripe's own delivery is left to
// the replay probe; what can be proven offline is pinned here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const source = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const schema = at("../../prisma/schema.prisma");
const webhookRaw = at("../../src/app/api/billing/webhook/route.ts");
const webhook = source(webhookRaw);
const events = source(at("../../src/lib/billing-events.ts"));
const stripeModule = source(at("../../src/lib/stripe.ts"));

describe("the claim table", () => {
  it("keys a claimed event by its id, with the time Stripe said it happened", () => {
    assert.match(schema, /model StripeEvent \{[\s\S]*?id\s+String\s+@id/);
    assert.match(schema, /model StripeEvent \{[\s\S]*?eventCreatedAt\s+DateTime/);
  });

  it("records arrival and completion separately", () => {
    // A row without processedAt is a delivery that was claimed and never
    // finished; its retry re-runs the handler instead of skipping the event.
    assert.match(schema, /processedAt\s+DateTime\?/);
    assert.match(events, /CLAIM_RETRY_MS/);
    assert.match(events, /processedAt\) return "duplicate";/);
    assert.match(events, /CLAIM_RETRY_MS \? "retry" : "in_flight"/);
  });

  it("keeps the watermark on the subscription row", () => {
    assert.match(schema, /model Subscription \{[\s\S]*?lastStripeEventAt\s+DateTime\?/);
    assert.match(stripeModule, /lastStripeEventAt: appliedEventAt/);
  });
});

describe("every verified delivery is claimed before it is handled", () => {
  it("claims after the signature check and before the switch", () => {
    const verifyAt = webhook.indexOf("verifyWebhook(rawBody, signature)");
    const claimAt = webhook.indexOf("claimStripeEvent(event)");
    const switchAt = webhook.indexOf("switch (event.type)");
    assert.ok(verifyAt >= 0 && claimAt > verifyAt, "a forged event never writes a claim row");
    assert.ok(switchAt > claimAt, "nothing runs before the claim");
  });

  it("answers a settled replay with duplicate: true", () => {
    assert.match(webhook, /claim === "duplicate"\) return NextResponse\.json\(\{ received: true, duplicate: true \}\)/);
  });

  it("answers a concurrent redelivery with a retryable non-2xx", () => {
    assert.match(
      webhook,
      /claim === "in_flight"\) return NextResponse\.json\(\{ error: "Event already in flight" \}, \{ status: 409 \}\)/,
    );
  });

  it("marks the event processed only after the handler ran", () => {
    const switchAt = webhook.indexOf("switch (event.type)");
    const finishAt = webhook.indexOf("finishStripeEvent(event.id)");
    assert.ok(finishAt > switchAt, "finished, not merely received");
  });

  it("keeps a failed claim loud", () => {
    assert.match(webhook, /status: 500/);
  });
});

describe("an older snapshot cannot drag the row backwards", () => {
  it("subscription branches pass the event's own created time", () => {
    assert.match(webhook, /await syncAndAnnounce\(event\.data\.object as Stripe\.Subscription, event\.created\);/);
    assert.match(webhook, /const applied = await syncAndAnnounce\(stripeSub, event\.created\);/);
  });

  it("refuses a snapshot older than the watermark", () => {
    assert.match(webhook, /previous\?\.lastStripeEventAt && at < previous\.lastStripeEventAt/);
    assert.match(webhook, /stale subscription event skipped/);
  });

  it("arms nothing from a stale event — the cancellation pair waits for an applied sync", () => {
    assert.match(webhook, /if \(applied\) await armCancellation\(stripeSub\);/);
  });

  it("live retrievals never move the watermark", () => {
    // The checkout and payment-failed branches retrieve current state; only an
    // event-authored snapshot may write the watermark.
    assert.match(stripeModule, /export async function syncSubscriptionFromStripe\(stripeSub: Stripe\.Subscription, appliedEventAt\?: Date\)/);
    assert.match(webhook, /await syncSubscriptionFromStripe\(stripeSub\);/);
    assert.doesNotMatch(webhook, /syncSubscriptionFromStripe\(sub, /);
  });
});

describe("dunning says something that is still true", () => {
  it("sends only while money is actually owed", () => {
    assert.match(webhook, /const DUNNING_STATUSES = \["past_due", "unpaid", "incomplete"\]/);
    assert.match(webhook, /DUNNING_STATUSES as readonly string\[\]\)\.includes\(stripeSub\.status\)\) \{/);
  });

  it("the receipt's exactly-once claim is backed by the event claim", () => {
    assert.match(webhookRaw, /the event claim in POST is what keeps that true/);
  });
});
