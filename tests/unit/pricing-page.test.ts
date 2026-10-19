// #114 — the pricing page in front of somebody who already pays, pinned offline.
//
// The page cannot be driven without a session cookie, and its whole subject is
// the difference between two visitors, so what is asserted here is the shape of
// the decision: which questions it asks, and which of the three CTAs each visitor
// can reach. The arithmetic itself is a lookup of one row.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const pageRaw = at("../../src/app/pricing/page.tsx");
const page = source(pageRaw);

const MONTHLY = "FLAT_MONTHLY";
const ANNUAL = "FLAT_ANNUAL";

const PLAN_LINE = /function planLine\(plan: Plan\): string \{([\s\S]*?)\n\}/.exec(page);
assert.ok(PLAN_LINE, "planLine is defined in the page module");

describe("the page asks who is looking at it", () => {
  it("reads the session, then the row that belongs to it", () => {
    assert.match(page, /const session = await getSession\(\);/);
    assert.match(page, /prisma\.subscription\.findUnique\(\{\s*where: \{ workspaceId: session\.workspaceId \}/);
  });

  it("asks nothing of Stripe to render a sales page", () => {
    assert.doesNotMatch(page, /getStripe\(\)/);
    assert.doesNotMatch(page, /subscriptions\.retrieve|subscriptions\.list/);
  });

  it("uses the same live-subscription set as the checkout route", () => {
    assert.match(page, /SUBSCRIPTION_STATUS_OPEN as readonly string\[\]\)\.includes\(plan\.status\)/);
    assert.doesNotMatch(page, /\[\s*"trialing"/, "the set is named once, in lib/stripe.ts");
  });
});

describe("a paying workspace is not sold a trial", () => {
  it("marks the plan it is on, and points the other card at the portal", () => {
    assert.equal((page.match(/>Your plan</g) ?? []).length, 2, "one per card");
    assert.equal((page.match(/label="Switch in the portal"/g) ?? []).length, 2);
    assert.equal((page.match(/label="Change plan in the portal"/g) ?? []).length, 1, "the strip above the cards");
  });

  it("keeps both trial buttons reachable for anybody who is not paying", () => {
    assert.equal((page.match(/<BuyButton/g) ?? []).length, 2);
    assert.ok(page.includes(`<BuyButton priceId="${MONTHLY}"`), MONTHLY);
    assert.ok(page.includes(`<BuyButton priceId="${ANNUAL}"`), ANNUAL);
  });

  it("decides by the price on the row, not by which card is highlighted", () => {
    assert.match(page, new RegExp(`plan\\?\\.stripePriceId === PRICES\\.${MONTHLY}`));
    assert.match(page, new RegExp(`plan\\?\\.stripePriceId === PRICES\\.${ANNUAL}`));
  });

  it("gives the buy buttons back to a workspace that cancelled", () => {
    // "Your plan" is only true while there is a live subscription to be on;
    // the price id survives a cancellation, and keying off it alone left
    // churned buyers with no way back in.
    assert.equal((page.match(/billed && plan\?\.stripePriceId/g) ?? []).length, 2);
  });

  it("says nothing when it knows nothing", () => {
    assert.match(page, /const billed = plan !== null &&/);
    assert.match(page, /\{billed && plan \? \(/);
  });

  it("answers the question the 409 would otherwise raise", () => {
    assert.match(pageRaw, /second subscription/);
  });
});

describe("the line about the current plan", () => {
  it("names the three billed states differently", () => {
    assert.match(PLAN_LINE[1], /plan\.status === "trialing"/);
    assert.match(PLAN_LINE[1], /plan\.status === "past_due"/);
    assert.match(PLAN_LINE[1], /This workspace is on the \$\{named\} plan/);
  });

  it("only states a date it actually has", () => {
    assert.match(PLAN_LINE[1], /renews \? ` until \$\{renews\}` : ""/);
    assert.match(PLAN_LINE[1], /renews \? `, renews \$\{renews\}` : ""/);
  });

  it("falls back to a plain word when the stored price matches neither card", () => {
    assert.match(PLAN_LINE[1], /: "current"/);
  });

  it("reads the date through a module-level helper, not during render", () => {
    assert.match(page, /function renewalDate\(periodEnd: Date \| null\): string \| null \{/);
    assert.match(page, /new Intl\.DateTimeFormat\("en", \{ dateStyle: "medium" \}\)\.format\(periodEnd\)/);
  });

  it("tells a past-due buyer that paying again is the wrong fix", () => {
    assert.match(PLAN_LINE[1], /a new subscription would not pay the old one/);
  });

  it("tells an unpaid buyer the invoice, not the card, is what settles it", () => {
    assert.match(PLAN_LINE[1], /plan\.status === "unpaid"/);
    assert.match(PLAN_LINE[1], /the open invoice is settled/);
  });
});
