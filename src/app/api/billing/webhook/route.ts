import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, verifyWebhook, syncSubscriptionFromStripe } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/tokens";
import { claimStripeEvent, finishStripeEvent } from "@/lib/billing-events";
import { armCancellationJobs, ownerOf, scheduleTrialNudges } from "@/lib/billing-jobs";
import {
  getEmailSender,
  renderPaymentFailedEmail,
  renderPaymentRecoveredEmail,
  renderReceiptEmail,
  renderTrialEndedEmail,
} from "@/lib/email";

export const dynamic = "force-dynamic";

const productName = () => process.env.PRODUCT_NAME ?? "Abetworks";

/**
 * The statuses that still describe an open payment problem. Dunning tells the
 * buyer their payment failed, so it is only true for these — a fresh retrieve
 * that comes back `active` means the failure is resolved (or Stripe is still
 * retrying the charge) and the mail would be telling a healthy buyer a lie.
 */
const DUNNING_STATUSES = ["past_due", "unpaid", "incomplete"] as const;

/**
 * Confirms the payment to the buyer. Driven off the checkout session (which
 * carries the customer email and the period end) rather than a later
 * subscription event, so the receipt fires exactly once per purchase — and
 * the event claim in POST is what keeps that true when Stripe redelivers.
 * Best-effort: a mail outage must not turn a paid, already-synced checkout
 * into a failed webhook — Stripe would retry and re-run the sync.
 */
async function sendReceipt(session: Stripe.Checkout.Session) {
  const email = session.customer_details?.email ?? session.customer_email;
  if (!email) return;
  const subId = typeof session.subscription === "string" ? session.subscription : undefined;
  let periodEnd: Date | null = null;
  let trialing = false;
  if (subId) {
    try {
      const sub = await getStripe().subscriptions.retrieve(subId);
      const raw = sub.items.data[0]?.current_period_end;
      if (typeof raw === "number") periodEnd = new Date(raw * 1000);
      trialing = sub.status === "trialing";
    } catch {
      // period end is a nicety; a receipt without a date still confirms payment.
    }
  }
  const { subject, html, text: plain } = renderReceiptEmail({
    product: productName(),
    name: session.customer_details?.name ?? null,
    planLabel: `${productName()} subscription`,
    periodEnd,
    portalUrl: `${appBaseUrl()}/dashboard`,
    trialing,
  });
  await getEmailSender()
    .send(email, subject, html, plain)
    .catch(() => undefined);
}

/**
 * Same best-effort rule as the receipt: the sync has already committed, so a
 * mail failure must not make Stripe retry the whole webhook. The buyer learns
 * about the decline from the portal banner if not from us — but usually from us.
 *
 * The address comes from the workspace, not from Stripe. `ensureCustomer`
 * creates the customer with an empty email — checkout collects one from the
 * buyer, but nothing guarantees Stripe writes it back — so a customer-shaped
 * lookup is a way to lose a declined-payment notice over a field this app
 * already holds. One source also means one answer for every billing mail.
 */
async function sendDunning(stripeSub: Stripe.Subscription) {
  const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
  if (!workspaceId) return;
  const owner = await ownerOf(workspaceId);
  if (!owner) return;
  const { subject, html, text: plain } = renderPaymentFailedEmail({
    product: productName(),
    name: owner.user.name,
    portalUrl: `${appBaseUrl()}/dashboard`,
  });
  await getEmailSender()
    .send(owner.user.email, subject, html, plain)
    .catch(() => undefined);
}

/**
 * Arm the "your trial ends soon" warnings for a subscription that is on trial.
 *
 * Best-effort in the same shape as every other mail here: the sync has already
 * committed, and a Redis that is down must not answer non-200 and make Stripe
 * retry a webhook that has nothing left to do. Missing a nudge costs a worse
 * conversion rate; failing a confirmed payment event costs the buyer's record.
 *
 * Safe to hit repeatedly — the job id names the trial end, so the retry of a
 * `checkout.session.completed` and the `customer.subscription.created` that
 * follows it arm the same two warnings once each, and a genuinely new trial
 * period arms new ones.
 */
async function armTrialNudges(stripeSub: Stripe.Subscription) {
  if (stripeSub.status !== "trialing") return;
  const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
  const raw = stripeSub.items.data[0]?.current_period_end;
  if (!workspaceId || typeof raw !== "number") return;
  try {
    await scheduleTrialNudges(workspaceId, new Date(raw * 1000));
  } catch (error) {
    console.error("[billing] trial nudges not armed:", error);
  }
}

/**
 * The two mails an ended subscription gets: the confirmation now, and the
 * come-back offer a week later. Both are armed rather than sent inline for the
 * reason every mail here has the same shape — the sync has already committed,
 * so nothing in this branch may answer non-200 and make Stripe re-run an event
 * that is finished. A down Redis costs the win-back and nothing else.
 *
 * Fires for a trial that lapsed without converting too, which is the right
 * behaviour: the copy says nothing was charged and nothing was deleted, and both
 * are true either way.
 */
async function armCancellation(stripeSub: Stripe.Subscription) {
  const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
  if (!workspaceId) return;
  try {
    await armCancellationJobs(workspaceId, stripeSub.id);
  } catch (error) {
    console.error("[billing] cancellation mails not armed:", error);
  }
}

/**
 * Say what the buyer just agreed to, and who gets told. Split out of
 * `syncAndAnnounce` because the answer has to be reachable without a Stripe
 * round-trip: the customer this app creates has no email of its own, and a
 * decline or a conversion that cannot find an address must not go silent.
 */
async function announceTransition(workspaceId: string, from: string, stripeSub: Stripe.Subscription) {
  const converted =
    (from === "trialing" && stripeSub.status === "active") ||
    (from === "past_due" && stripeSub.status === "active");
  if (!converted) return;

  const owner = await ownerOf(workspaceId);
  if (!owner) return;

  const itemPeriodEnd = stripeSub.items.data[0]?.current_period_end;
  const periodEnd = typeof itemPeriodEnd === "number" ? new Date(itemPeriodEnd * 1000) : null;

  const rendered =
    from === "trialing"
      ? renderTrialEndedEmail({
          product: productName(),
          name: owner.user.name,
          periodEnd,
          portalUrl: `${appBaseUrl()}/dashboard`,
        })
      : renderPaymentRecoveredEmail({
          product: productName(),
          name: owner.user.name,
          portalUrl: `${appBaseUrl()}/dashboard`,
        });

  await getEmailSender()
    .send(owner.user.email, rendered.subject, rendered.html, rendered.text)
    .catch(() => undefined);
}

/**
 * The two transitions that deserve an email of their own: a trial that
 * converted to a paid plan (the money moment, and the one buyers most often
 * forget they authorised) and a past-due subscription that recovered (silence
 * here reads as "still broken" and prompts a cancellation).
 *
 * Reads the previous status from the local row *before* the sync overwrites
 * it — Stripe events do not carry the old state, and a transition you cannot
 * see is a transition you cannot announce.
 *
 * `eventCreatedAt` is the event's own `created`. Stripe delivers in no
 * promised order, so an older snapshot arriving after a newer one has been
 * applied is refused here: it would otherwise drag the row backwards (a
 * "trialing" snapshot overwriting "active" for a buyer who is paying). The
 * exact replay of a settled event never reaches this point — the claim in
 * POST answers it. Returns whether the event was applied; `false` means a
 * late, already-superseded snapshot, which must not arm anything either.
 */
async function syncAndAnnounce(stripeSub: Stripe.Subscription, eventCreatedAt: number) {
  const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
  const previous = workspaceId
    ? await prisma.subscription.findUnique({
        where: { workspaceId },
        select: { status: true, lastStripeEventAt: true },
      })
    : null;

  const at = new Date(eventCreatedAt * 1000);
  if (previous?.lastStripeEventAt && at < previous.lastStripeEventAt) {
    console.log(
      `[billing] stale subscription event skipped: ${at.toISOString()} < ${previous.lastStripeEventAt.toISOString()}`,
    );
    return false;
  }

  await syncSubscriptionFromStripe(stripeSub, at);
  await armTrialNudges(stripeSub);

  if (previous && workspaceId && previous.status !== stripeSub.status) {
    try {
      await announceTransition(workspaceId, previous.status, stripeSub);
    } catch (error) {
      // Swallowed on purpose. The sync above has already overwritten the status,
      // so the retry that answering non-200 buys no longer sees a transition to
      // announce: a loud failure here does not delay the mail, it deletes it.
      console.error("[billing] transition mail not sent:", error);
    }
  }
  return true;
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  let event;
  try {
    event = verifyWebhook(rawBody, signature);
  } catch (err) {
    console.error("[billing] webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const claim = await claimStripeEvent(event).catch((error) => {
    // Nothing has happened yet, so the failure can be loud: the claim table is
    // the record that this delivery was seen, and a delivery without a record
    // must be retried by Stripe rather than half-processed.
    console.error("[billing] event claim failed:", error);
    return null;
  });
  if (!claim) {
    return NextResponse.json({ error: "Event not recorded" }, { status: 500 });
  }
  if (claim !== "process") {
    // "duplicate" is a replay of a settled event. "in_flight" is the same id
    // arriving while its first attempt is still running — non-2xx asks Stripe
    // to come back later, by which time the first attempt has finished
    // ("duplicate") or died ("retry" on a later delivery). "retry" itself
    // means a claim was written once and never finished: run it again now.
    console.log(`[billing] ${event.type}: ${claim} (${event.id})`);
    if (claim === "duplicate") return NextResponse.json({ received: true, duplicate: true });
    if (claim === "in_flight") return NextResponse.json({ error: "Event already in flight" }, { status: 409 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && typeof session.subscription === "string") {
        const sub = await getStripe().subscriptions.retrieve(session.subscription);
        await syncSubscriptionFromStripe(sub);
        await armTrialNudges(sub);
        await sendReceipt(session);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      await syncAndAnnounce(event.data.object as Stripe.Subscription, event.created);
      break;
    }
    case "customer.subscription.deleted": {
      const stripeSub = event.data.object as Stripe.Subscription;
      const applied = await syncAndAnnounce(stripeSub, event.created);
      if (applied) await armCancellation(stripeSub);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Invoice shape drifts across SDK versions (subscription vs parent
      // .subscription_details.subscription) — read defensively, skip if absent.
      const inv = invoice as Stripe.Invoice & { subscription?: unknown };
      const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: unknown } } }).parent;
      const subId =
        typeof inv.subscription === "string"
          ? inv.subscription
          : typeof parent?.subscription_details?.subscription === "string"
            ? parent.subscription_details.subscription
            : undefined;
      if (subId) {
        const stripeSub = await getStripe().subscriptions.retrieve(subId);
        await syncSubscriptionFromStripe(stripeSub);
        if ((DUNNING_STATUSES as readonly string[]).includes(stripeSub.status)) {
          await sendDunning(stripeSub);
        }
      }
      break;
    }
    default:
      console.log(`[billing] unhandled event: ${event.type}`);
  }

  await finishStripeEvent(event.id);
  return NextResponse.json({ received: true });
}