// #109 — the cancellation pair, pinned offline.
//
// Two claims hold this mail together. The copy promises that nothing was
// deleted and nothing further is charged, which is a fact about Stripe's event
// and this app's data policy — so it is asserted as text. And the week-old
// win-back must not reach someone who came back, which is a fact about the row
// at firing time — so the guard is asserted against the source, the same method
// `trial-nudge.test.ts` uses for what cannot run without Redis and a database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderCancellationEmail, renderWinbackEmail } from "../../src/lib/email";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const jobs = source("../../src/lib/billing-jobs.ts");
const queueModule = source("../../src/lib/queue.ts");
const webhook = source("../../src/app/api/billing/webhook/route.ts");

const PRICING = "https://x.test/pricing";

describe("renderCancellationEmail", () => {
  it("says what happened, in the subject", () => {
    const { subject } = renderCancellationEmail({ product: "LeadWorks", name: "V", pricingUrl: PRICING });
    assert.match(subject, /^LeadWorks — your subscription is canceled$/);
  });

  it("answers the two questions a cancellation actually raises", () => {
    const { text } = renderCancellationEmail({ product: "LeadWorks", name: null, pricingUrl: PRICING });
    assert.match(text, /no further charge will be made/i);
    assert.match(text, /nothing was deleted|nothing has been deleted/i);
  });

  it("does not argue with the decision", () => {
    // A cancellation mail that tries to talk you out of cancelling is the one
    // this product already has — the win-back, a week later, on purpose.
    const { text } = renderCancellationEmail({ product: "LeadWorks", name: null, pricingUrl: PRICING });
    assert.doesNotMatch(text, /wait|don'?t go|last chance|discount/i);
  });

  it("links the pricing page in both renders", () => {
    const { html, text } = renderCancellationEmail({ product: "LeadWorks", name: "V", pricingUrl: PRICING });
    assert.match(html, /href="https:\/\/x\.test\/pricing"/);
    assert.match(text, /https:\/\/x\.test\/pricing/);
  });

  it("never renders a placeholder", () => {
    for (const render of [renderCancellationEmail({ product: "LeadWorks", name: null, pricingUrl: PRICING })]) {
      assert.doesNotMatch(render.html + render.text, /undefined|Invalid Date|Hi null/);
    }
  });
});

describe("renderWinbackEmail", () => {
  it("leads with the thing that is actually being offered: nothing to redo", () => {
    const { subject, text } = renderWinbackEmail({ product: "LeadWorks", name: "V", pricingUrl: PRICING });
    assert.match(subject, /^Your LeadWorks workspace is still exactly as you left it$/);
    assert.match(text, /nothing has been deleted/i);
    assert.match(text, /a week since/i);
  });

  it("names the risk it is removing — coming back starts on another trial", () => {
    const { text } = renderWinbackEmail({ product: "LeadWorks", name: null, pricingUrl: PRICING });
    assert.match(text, /another 14 days before the first charge/i);
  });

  it("links the pricing page, which is the page that starts a new subscription", () => {
    const { html, text } = renderWinbackEmail({ product: "LeadWorks", name: "V", pricingUrl: PRICING });
    assert.match(html, /href="https:\/\/x\.test\/pricing"/);
    assert.match(text, /https:\/\/x\.test\/pricing/);
    assert.doesNotMatch(html + text, /undefined|Invalid Date|Hi null/);
  });
});

describe("arming the pair", () => {
  it("waits a week for the come-back mail", () => {
    assert.match(jobs, /export const WINBACK_DELAY_DAYS = 7/);
  });

  it("sends the confirmation without delay and the win-back with it", () => {
    assert.match(
      jobs,
      /enqueue\(queues\.billing, "canceled", data, \{ jobId: `\$\{stripeSubscriptionId\}-canceled` \}\)/,
      "the confirmation carries no delay — day zero is when the buyer wants the receipt-shaped mail",
    );
    assert.match(
      jobs,
      /enqueue\(queues\.billing, "winback", data, \{[\s\S]*?delay: WINBACK_DELAY_DAYS \* 86_400_000/,
    );
  });

  it("ids both on the Stripe subscription, which is deleted exactly once", () => {
    // The workspace id would be wrong: a buyer who comes back and leaves again
    // is a second cancellation and deserves a second pair of mails. A
    // re-delivered event for the same subscription is not, and gets refused.
    assert.match(jobs, /jobId: `\$\{stripeSubscriptionId\}-canceled`/);
    assert.match(jobs, /jobId: `\$\{stripeSubscriptionId\}-winback`/);
    assert.doesNotMatch(jobs, /jobId: `\$\{workspaceId\}-canceled`/);
  });

  it("arms from the deleted event only, after the sync, and never instead of it", () => {
    const branch = /case "customer\.subscription\.deleted": \{([\s\S]*?)\n\s*\}/.exec(webhook);
    assert.ok(branch, "the deleted event has its own case");
    assert.match(branch[1], /await syncAndAnnounce\(stripeSub\);/);
    assert.match(branch[1], /await armCancellation\(stripeSub\);/);
    // created and updated must not arm a cancellation mail.
    assert.doesNotMatch(webhook, /case "customer\.subscription\.created":\n\s*case "customer\.subscription\.updated":\n\s*case "customer\.subscription\.deleted":/);
  });

  it("needs the workspace the mail is about, and survives a down Redis", () => {
    const body = /async function armCancellation\(stripeSub: Stripe\.Subscription\) \{([\s\S]*?)\n\}/.exec(webhook);
    assert.ok(body, "armCancellation is defined in the webhook route");
    assert.match(body[1], /if \(!workspaceId\) return;/);
    assert.match(body[1], /catch \(error\)/);
  });
});

describe("sending a cancellation mail that is still true", () => {
  it("re-reads the row and stays silent for a workspace that came back", () => {
    const guard = /async function ownerIfStillCanceled\(data: CancellationData\) \{([\s\S]*?)\n\}/.exec(jobs);
    assert.ok(guard, "both mails share one still-canceled check");
    assert.match(guard[1], /prisma\.subscription\.findUnique\(\{ where: \{ workspaceId: data\.workspaceId \} \}\)/);
    assert.match(guard[1], /subscription\.status !== "canceled"\) return null;/);
  });

  it("also refuses a newer subscription's status", () => {
    // `canceled` proves nothing on its own — the row is upserted by every sync,
    // so a status left by a *later* subscription would otherwise answer for
    // this one. The id is the only thing that ties the row to the job.
    assert.match(jobs, /subscription\.stripeSubscriptionId !== data\.stripeSubscriptionId\) return null;/);
  });

  it("judges at firing time, in both mails", () => {
    for (const name of ["runCancellation", "runWinback"]) {
      const body = new RegExp(`export async function ${name}\\(job: Job<CancellationData>\\): Promise<void> \\{([\\s\\S]*?)\\n}`);
      const match = body.exec(jobs);
      assert.ok(match, `${name} is exported from the billing jobs`);
      assert.match(match[1], /ownerIfStillCanceled\(job\.data\)/);
      assert.match(match[1], /if \(!owner\) return;/);
      assert.match(match[1], /\.catch\(\(\) => undefined\)/);
    }
  });

  it("writes to the owner, oldest membership first", () => {
    assert.match(jobs, /role: "OWNER"/);
    assert.match(jobs, /orderBy: \{ createdAt: "asc" \}/);
  });
});

describe("one worker, every billing job", () => {
  it("dispatches by job name", () => {
    const dispatcher = /export async function runBillingJob\(job: Job<TrialNudgeData \| CancellationData>\): Promise<void> \{([\s\S]*?)\n\}/.exec(jobs);
    assert.ok(dispatcher, "runBillingJob is exported");
    for (const name of ["trial-nudge", "canceled", "winback"]) {
      assert.match(dispatcher[1], new RegExp(`case "${name}"`));
    }
  });

  it("fails an unknown name instead of dropping it", () => {
    // A queue that gains a kind without gaining a branch would otherwise sit
    // with a completed job and no email — the one failure mode this file is
    // about. A failed job is visible in /api/health and kept by removeOnFail.
    const dispatcher = /export async function runBillingJob\(job: Job<TrialNudgeData \| CancellationData>\): Promise<void> \{([\s\S]*?)\n\}/.exec(jobs);
    assert.ok(dispatcher);
    assert.match(dispatcher[1], /throw new Error\(`Unknown billing job: \$\{job\.name\}`\)/);
  });

  it("is what the billing Worker actually runs", () => {
    assert.match(queueModule, /new Worker\("leadworks-billing", async \(job: Job\) => \{\s*await runBillingJob\(job as Job<TrialNudgeData \| CancellationData>\)/);
    assert.match(queueModule, /const \{ runBillingJob \} = await import\("\.\/billing-jobs"\)/);
  });
});
