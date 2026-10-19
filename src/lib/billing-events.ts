/**
 * Stripe delivers webhooks at least once and in no promised order: a delivery
 * that times out is retried, the dashboard's Resend button replays an event on
 * demand, and two events about the same subscription can arrive swapped. The
 * route therefore cannot assume "each event is seen once" — it has to make the
 * question answerable, and that is the whole of this file.
 *
 * Every verified delivery is claimed by its event id before any handler runs.
 * The first claim processes; a later delivery of the same id answers
 * `duplicate` without touching state or sending mail. A claim that was written
 * but never finished (the process died mid-event) is re-run by its retry
 * rather than refused — the row records processing, not just arrival.
 */
import { prisma } from "./db";

export type StripeEventClaim = "process" | "duplicate" | "retry" | "in_flight";

/**
 * How long an unfinished claim may sit before its retry is allowed to process
 * the event again. Shorter and a genuinely concurrent redelivery would run the
 * handler twice; longer and a delivery that died mid-flight waits past
 * Stripe's first retry for no reason.
 */
export const CLAIM_RETRY_MS = 60_000;

export async function claimStripeEvent(event: { id: string; type: string; created: number }): Promise<StripeEventClaim> {
  try {
    await prisma.stripeEvent.create({
      data: { id: event.id, type: event.type, eventCreatedAt: new Date(event.created * 1000) },
    });
    return "process";
  } catch (error) {
    // The id being taken is the expected race; anything else is a real
    // failure, and the route answers non-200 so Stripe retries the delivery.
    if ((error as { code?: string }).code !== "P2002") throw error;
  }

  const existing = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
  if (!existing) return "process";
  if (existing.processedAt) return "duplicate";
  return Date.now() - existing.createdAt.getTime() > CLAIM_RETRY_MS ? "retry" : "in_flight";
}

export async function finishStripeEvent(id: string): Promise<void> {
  // Best-effort: the event body has already been applied, and bookkeeping that
  // fails must not make Stripe redeliver an event whose side effects are done.
  // An unmarked row only costs one re-run if a redelivery later arrives.
  await prisma.stripeEvent
    .update({ where: { id }, data: { processedAt: new Date() } })
    .catch(() => undefined);
}
