// #108 — the trial nudge, pinned offline.
//
// What the buyer is told and what the code actually guarantees are two different
// claims, so both are asserted here: the copy must not promise a charge date it
// does not know, and the job must not fire at a workspace that already converted,
// cancelled, or had its trial moved. The send itself needs Redis and a database,
// so the job module is read as source — the same method `queue.test.ts` uses for
// the properties that cannot be reached without a live keyspace.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderTrialNudgeEmail } from "../../src/lib/email";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const jobs = source("../../src/lib/billing-jobs.ts");
const queueModule = source("../../src/lib/queue.ts");
const webhook = source("../../src/app/api/billing/webhook/route.ts");

describe("renderTrialNudgeEmail", () => {
  const periodEnd = new Date(Date.UTC(2026, 10, 3, 9, 0, 0));

  it("puts the remaining days in the subject, and agrees with itself on one", () => {
    const three = renderTrialNudgeEmail({ product: "LeadWorks", name: "V", daysLeft: 3, periodEnd, dashboardUrl: "https://x.test/dashboard" });
    const one = renderTrialNudgeEmail({ product: "LeadWorks", name: null, daysLeft: 1, periodEnd, dashboardUrl: "https://x.test/dashboard" });
    assert.match(three.subject, /^3 days left in your LeadWorks trial$/);
    assert.match(one.subject, /^1 day left in your LeadWorks trial$/);
  });

  it("states the charge date and repeats the cancel-anytime promise", () => {
    const { text } = renderTrialNudgeEmail({ product: "LeadWorks", name: null, daysLeft: 3, periodEnd, dashboardUrl: "https://x.test/dashboard" });
    assert.match(text, /nothing is charged before then/i);
    assert.match(text, /cancel from the billing portal any time up to that date and you are never billed/i);
    assert.match(text, /November 3, 2026/i, "the date the subject counts down to is named in the body");
  });

  it("carries the dashboard link into both renders", () => {
    const { html, text } = renderTrialNudgeEmail({ product: "LeadWorks", name: null, daysLeft: 1, periodEnd, dashboardUrl: "https://x.test/dashboard" });
    assert.match(html, /href="https:\/\/x\.test\/dashboard"/);
    assert.match(text, /https:\/\/x\.test\/dashboard/);
  });

  it("reads correctly with no name on the account", () => {
    const { text } = renderTrialNudgeEmail({ product: "LeadWorks", name: null, daysLeft: 2, periodEnd, dashboardUrl: "https://x.test/dashboard" });
    assert.match(text, /^Hi, you have 2 days of full access left/m);
    assert.doesNotMatch(text, /Hi null|Hi undefined/);
  });

  it("never renders a placeholder where the date should be", () => {
    const { html, text } = renderTrialNudgeEmail({ product: "LeadWorks", name: "V", daysLeft: 1, periodEnd, dashboardUrl: "https://x.test/dashboard" });
    for (const render of [html, text]) {
      assert.doesNotMatch(render, /undefined|Invalid Date|null/);
    }
  });
});

describe("arming the nudges", () => {
  it("warns at three days and one day, and not more often than that", () => {
    assert.match(jobs, /export const TRIAL_NUDGE_DAYS = \[3, 1\]/);
  });

  it("never arms a warning whose fire time has already passed", () => {
    // A trial bought with two days left must not be told it had three.
    assert.match(jobs, /trialEnd - offset \* 86_400_000 > Date\.now\(\)/);
  });

  it("names the job after the trial period it belongs to", () => {
    // Two Stripe events arm the same trial (checkout.session.completed and
    // customer.subscription.created); without an id that carries the period end,
    // each one would queue its own pair of emails.
    assert.match(jobs, /jobId: `\$\{workspaceId\}-trial-nudge-\$\{offset\}-\$\{trialEnd\}`/);
  });

  it("is armed by the webhook, not by the sync — and never fails one", () => {
    assert.match(webhook, /await armTrialNudges\(sub\);/);
    assert.match(webhook, /await armTrialNudges\(stripeSub\);/);
    const body = /async function armTrialNudges\(stripeSub: Stripe\.Subscription\) \{([\s\S]*?)\n\}/.exec(webhook);
    assert.ok(body, "armTrialNudges is defined in the webhook route");
    assert.match(body[1], /if \(stripeSub\.status !== "trialing"\) return;/);
    assert.match(body[1], /catch \(error\)/, "a down Redis must not answer non-200 to a confirmed payment event");
  });
});

describe("sending a nudge that is still true", () => {
  it("re-reads the subscription at firing time instead of trusting the payload", () => {
    assert.match(jobs, /prisma\.subscription\.findUnique\(\{ where: \{ workspaceId \} \}\)/);
    assert.match(jobs, /subscription\.status !== "trialing"\) return;/);
  });

  it("stays silent once the trial is over or has moved out", () => {
    assert.match(jobs, /if \(daysLeft <= 0 \|\| daysLeft > offsetDays\) return;/);
  });

  it("writes to the owner, oldest membership first", () => {
    assert.match(jobs, /role: "OWNER"/);
    assert.match(jobs, /orderBy: \{ createdAt: "asc" \}/);
  });

  it("swallows a mail outage — the job already did the only durable thing it could", () => {
    assert.match(jobs, /\.catch\(\(\) => undefined\)/);
  });
});

describe("the billing queue is wired on both sides", () => {
  it("has a Queue and a Worker on the same name", () => {
    // Written twice on purpose, in both constructors: a Worker listening on a name
    // no Queue enqueues to drains nothing and says nothing about it.
    assert.match(queueModule, /new Queue\("leadworks-billing", /);
    assert.match(queueModule, /new Worker\("leadworks-billing", /);
  });

  it("is built lazily, so importing the module still writes nothing to Redis", () => {
    assert.match(queueModule, /get billing\(\): Queue \{\s*return \(built\.billing \?\?= new Queue\(/);
  });

  it("carries the retention default like every other queue in this app", () => {
    const construction = /new Queue\("leadworks-billing", \{([^}]*)\}\)/.exec(queueModule);
    assert.ok(construction, "the billing Queue is constructed with an options object");
    assert.match(construction[1], /defaultJobOptions: JOB_RETENTION/);
  });

  it("drains through the same worker list the shutdown closes", () => {
    assert.match(queueModule, /workers\.push\(new Worker\("leadworks-billing"/);
  });
});
