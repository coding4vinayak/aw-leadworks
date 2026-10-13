// #112 — who a billing mail is addressed to, pinned offline.
//
// Five billing mails, one recipient. Three of them are delayed jobs that look
// the address up when they fire; the two the webhook sends inline used to ask
// Stripe instead — on a customer this app creates with `ensureCustomer(workspaceId,
// "", "")`. An address Stripe never learned is a silent decline notice, and a
// Stripe call that throws *after* the sync has committed is worse than silence:
// the retry it provokes no longer sees a status transition, so the
// you-are-now-paying mail is destroyed rather than delayed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const source = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const webhookRaw = at("../../src/app/api/billing/webhook/route.ts");
const jobsRaw = at("../../src/lib/billing-jobs.ts");
const webhook = source(webhookRaw);
const jobs = source(jobsRaw);
const stripeModule = source(at("../../src/lib/stripe.ts"));

/** The body of one function in this file, comments already stripped. */
function body(text: string, name: string): string {
  const found = new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(text);
  assert.ok(found, `${name} is defined`);
  return found[1];
}

describe("the premise: Stripe may not know the buyer's address", () => {
  it("creates the customer with an empty email", () => {
    // Not a mistake to fix here — checkout collects the address from the buyer.
    // It is the reason a mail must never depend on Stripe having recorded it.
    assert.match(stripeModule, /ensureCustomer\(workspaceId, "", ""\)/);
  });

  it("keeps its own copy of who owns the workspace", () => {
    assert.match(jobs, /prisma\.membership\.findFirst\(\{/);
    assert.match(jobs, /role: "OWNER"/);
    assert.match(jobs, /orderBy: \{ createdAt: "asc" \}/);
  });
});

describe("one recipient rule, five mails", () => {
  it("is exported from where the jobs resolve it", () => {
    assert.match(jobs, /export async function ownerOf\(workspaceId: string\)/);
  });

  it("is used by both inline mails", () => {
    assert.match(body(webhook, "sendDunning"), /await ownerOf\(workspaceId\)/);
    assert.match(body(webhook, "announceTransition"), /await ownerOf\(workspaceId\)/);
  });

  it("is the only recipient source in the webhook", () => {
    assert.doesNotMatch(webhook, /customers\.retrieve/);
    // Receipt included: its address comes from the checkout payload, which the
    // buyer typed, so it needs no lookup at all.
    assert.match(body(webhook, "sendReceipt"), /session\.customer_details\?\.email \?\? session\.customer_email/);
  });

  it("says so when there is nobody to say it to", () => {
    for (const mail of ["sendDunning", "announceTransition"]) {
      assert.match(body(webhook, mail), /if \(!owner\) return;/);
    }
  });
});

describe("a committed sync may not be answered with a failure", () => {
  it("announces after the sync, never instead of it", () => {
    assert.match(webhook, /await syncSubscriptionFromStripe\(stripeSub\);/);
    const sync = body(webhook, "syncAndAnnounce");
    assert.ok(
      sync.indexOf("syncSubscriptionFromStripe") < sync.indexOf("announceTransition"),
      "the transition is announced once the row is already written",
    );
  });

  it("keeps the announce quiet", () => {
    const sync = body(webhook, "syncAndAnnounce");
    assert.match(sync, /try \{\s*await announceTransition\(workspaceId, previous\.status, stripeSub\);/);
    assert.match(sync, /catch \(error\)/);
    assert.match(sync, /console\.error\("\[billing\] transition mail not sent:"/);
  });

  it("leaves the loud failures loud", () => {
    // A signature that does not verify, and a sync that did not happen, are both
    // worth a retry. Only the mail after a commit is not.
    assert.match(webhook, /return NextResponse\.json\(\{ error: "Invalid signature" \}, \{ status: 400 \}\);/);
    assert.doesNotMatch(body(webhook, "syncAndAnnounce"), /catch[\s\S]*syncSubscriptionFromStripe/);
  });

  it("arms the cancellation pair in the same shape", () => {
    assert.match(body(webhook, "armCancellation"), /catch \(error\)/);
  });
});

describe("the transition itself still decides the mail", () => {
  it("announces only the two ways in to active", () => {
    const announce = body(webhook, "announceTransition");
    assert.match(announce, /from === "trialing" && stripeSub\.status === "active"/);
    assert.match(announce, /from === "past_due" && stripeSub\.status === "active"/);
    assert.match(announce, /if \(!converted\) return;/);
  });

  it("says sorry for the charge after a trial, and welcome back after a decline", () => {
    const announce = body(webhook, "announceTransition");
    assert.match(announce, /from === "trialing"\s*\?\s*renderTrialEndedEmail/);
    assert.match(announce, /:\s*renderPaymentRecoveredEmail/);
  });

  it("ignores a status it has already reported", () => {
    assert.match(body(webhook, "syncAndAnnounce"), /previous\.status === stripeSub\.status\) return;/);
  });
});

describe("the three paid apps share this file", () => {
  it("does not carry a stray doc block", () => {
    // Vendored verbatim into abetagent, leadgenius and leadworks by a script. A
    // paragraph left sitting above the wrong function describes code the reader
    // is about to skip, which is how a file like this starts lying.
    assert.equal((webhookRaw.match(/two transitions/g) ?? []).length, 1);
    assert.doesNotMatch(webhookRaw, /\*\/\n\/\*\*/);
    assert.doesNotMatch(jobsRaw, /\*\/\n\/\*\*/);
  });
});
