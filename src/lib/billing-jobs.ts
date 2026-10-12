import type { Job } from "bullmq";
import { prisma } from "./db";
import { appBaseUrl } from "./tokens";
import {
  getEmailSender,
  renderCancellationEmail,
  renderTrialNudgeEmail,
  renderWinbackEmail,
} from "./email";
import { queues, enqueue } from "./queue";

const productName = () => process.env.PRODUCT_NAME ?? "Abetworks";

/**
 * The remaining-day offsets worth a warning. Two, not one: day three catches
 * the team that got busy and day one catches the one that forgot. More than
 * that and the trial stops feeling like a trial.
 */
export const TRIAL_NUDGE_DAYS = [3, 1];

/**
 * How long after a cancellation the come-back mail waits. Day zero is the day
 * they decided, and a mail on the same day reads as a dispute. A week is the
 * point at which the work the product was doing starts being missing.
 */
export const WINBACK_DELAY_DAYS = 7;

export type TrialNudgeData = { workspaceId: string; offsetDays: number };
export type CancellationData = { workspaceId: string; stripeSubscriptionId: string };

/** Whole days until a date, rounded up — the number a buyer reads as "how long I have". */
function daysUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

/**
 * Whoever gets billed gets told. The oldest OWNER membership is the account
 * that ran checkout, so it is the address that recognises the message; a later
 * OWNER added by an invite is not.
 */
async function ownerOf(workspaceId: string) {
  return prisma.membership.findFirst({
    where: { workspaceId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { email: true, name: true } } },
  });
}

/**
 * Arm the warnings for one trial. Delayed BullMQ jobs rather than a scheduled
 * sweep: a delayed job survives a redeploy because it lives in Redis, and it
 * needs no cron caller — which matters, because this portfolio has a scheduler
 * with no caller before it (#55).
 *
 * The job id names the exact trial end, so a Stripe webhook retry arms the same
 * warning again and gets refused, while a genuinely new trial (new period end)
 * arms fresh ones.
 */
export async function scheduleTrialNudges(workspaceId: string, periodEnd: Date): Promise<number> {
  const trialEnd = periodEnd.getTime();
  const offsets = TRIAL_NUDGE_DAYS.filter((offset) => trialEnd - offset * 86_400_000 > Date.now());
  await Promise.all(
    offsets.map((offset) =>
      enqueue(queues.billing, "trial-nudge", { workspaceId, offsetDays: offset } satisfies TrialNudgeData, {
        delay: trialEnd - offset * 86_400_000 - Date.now(),
        jobId: `${workspaceId}-trial-nudge-${offset}-${trialEnd}`,
      }),
    ),
  );
  return offsets.length;
}

/**
 * One warning, checked against the database at firing time rather than at
 * arming time. Anything that changed in between — converted, cancelled, the
 * trial extended — is a reason not to send, and the row is the record this app
 * trusts (the same reason the dashboard banner reads Prisma and not Stripe).
 */
export async function runTrialNudge(job: Job<TrialNudgeData>): Promise<void> {
  const { workspaceId, offsetDays } = job.data;
  const subscription = await prisma.subscription.findUnique({ where: { workspaceId } });
  if (!subscription || subscription.status !== "trialing") return;
  const periodEnd = subscription.stripeCurrentPeriodEnd;
  if (!periodEnd) return;

  const daysLeft = daysUntil(periodEnd);
  // Zero means Stripe already ended it — the conversion email covers that. A
  // larger number means the trial moved out, so this warning is no longer true.
  if (daysLeft <= 0 || daysLeft > offsetDays) return;

  const owner = await ownerOf(workspaceId);
  if (!owner) return;

  const rendered = renderTrialNudgeEmail({
    product: productName(),
    name: owner.user.name,
    daysLeft,
    periodEnd,
    dashboardUrl: `${appBaseUrl()}/dashboard`,
  });
  await getEmailSender()
    .send(owner.user.email, rendered.subject, rendered.html, rendered.text)
    .catch(() => undefined);
}

/**
 * Arm both cancellation mails for one ended subscription.
 *
 * The Stripe subscription id *is* the idempotency key: a subscription is
 * deleted once, and a buyer who comes back gets a new subscription with a new
 * id, so re-delivery of the event cannot double-send while a second
 * cancellation of the same workspace still produces its own pair. The
 * confirmation is a job with no delay rather than an inline send for the same
 * reason as the nudges — arming must never be the thing that fails a webhook
 * that has already committed its sync.
 */
export async function armCancellationJobs(workspaceId: string, stripeSubscriptionId: string): Promise<void> {
  const data = { workspaceId, stripeSubscriptionId } satisfies CancellationData;
  await Promise.all([
    enqueue(queues.billing, "canceled", data, { jobId: `${stripeSubscriptionId}-canceled` }),
    enqueue(queues.billing, "winback", data, {
      jobId: `${stripeSubscriptionId}-winback`,
      delay: WINBACK_DELAY_DAYS * 86_400_000,
    }),
  ]);
}

/**
 * The row, but only while it still describes the cancellation this job was
 * armed for.
 *
 * A week is long enough for a change of heart: a workspace that cancelled and
 * bought again is not a churn risk, and mailing "you are gone" to someone
 * paying for the product is worse than mailing nothing. The subscription id is
 * checked as well as the status, because `canceled` on a *newer* subscription
 * means this job belongs to a cancellation already superseded.
 */
async function ownerIfStillCanceled(data: CancellationData) {
  const subscription = await prisma.subscription.findUnique({ where: { workspaceId: data.workspaceId } });
  if (!subscription || subscription.status !== "canceled") return null;
  if (subscription.stripeSubscriptionId !== data.stripeSubscriptionId) return null;
  return ownerOf(data.workspaceId);
}

/** The pair of mails an ended subscription produces, both judged at fire time. */
export async function runCancellation(job: Job<CancellationData>): Promise<void> {
  const owner = await ownerIfStillCanceled(job.data);
  if (!owner) return;
  const rendered = renderCancellationEmail({
    product: productName(),
    name: owner.user.name,
    pricingUrl: `${appBaseUrl()}/pricing`,
  });
  await getEmailSender()
    .send(owner.user.email, rendered.subject, rendered.html, rendered.text)
    .catch(() => undefined);
}

export async function runWinback(job: Job<CancellationData>): Promise<void> {
  const owner = await ownerIfStillCanceled(job.data);
  if (!owner) return;
  const rendered = renderWinbackEmail({
    product: productName(),
    name: owner.user.name,
    pricingUrl: `${appBaseUrl()}/pricing`,
  });
  await getEmailSender()
    .send(owner.user.email, rendered.subject, rendered.html, rendered.text)
    .catch(() => undefined);
}
/**
 * The one handler the billing Worker is built with. Dispatched by job name
 * because the names are the only thing separating a `{workspaceId, offsetDays}`
 * payload from a `{workspaceId, stripeSubscriptionId}` one — an unknown name
 * throws rather than silently doing nothing, so a queue that gains a kind
 * without gaining a branch here shows up as a failed job instead of a missing
 * email nobody notices.
 */
export async function runBillingJob(job: Job<TrialNudgeData | CancellationData>): Promise<void> {
  switch (job.name) {
    case "trial-nudge":
      return runTrialNudge(job as Job<TrialNudgeData>);
    case "canceled":
      return runCancellation(job as Job<CancellationData>);
    case "winback":
      return runWinback(job as Job<CancellationData>);
    default:
      throw new Error(`Unknown billing job: ${job.name}`);
  }
}
