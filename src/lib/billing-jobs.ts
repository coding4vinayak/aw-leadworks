import type { Job } from "bullmq";
import { prisma } from "./db";
import { appBaseUrl } from "./tokens";
import { getEmailSender, renderTrialNudgeEmail } from "./email";
import { queues, enqueue } from "./queue";

const productName = () => process.env.PRODUCT_NAME ?? "Abetworks";

/**
 * The remaining-day offsets worth a warning. Two, not one: day three catches
 * the team that got busy and day one catches the one that forgot. More than
 * that and the trial stops feeling like a trial.
 */
export const TRIAL_NUDGE_DAYS = [3, 1];

export type TrialNudgeData = { workspaceId: string; offsetDays: number };

/** Whole days until a date, rounded up — the number a buyer reads as "how long I have". */
function daysUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
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

  const owner = await prisma.membership.findFirst({
    where: { workspaceId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { email: true, name: true } } },
  });
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
