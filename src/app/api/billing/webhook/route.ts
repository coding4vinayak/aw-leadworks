import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, verifyWebhook, syncSubscriptionFromStripe } from "@/lib/stripe";
import { appBaseUrl } from "@/lib/tokens";
import { getEmailSender, renderReceiptEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const productName = () => process.env.PRODUCT_NAME ?? "Abetworks";

/**
 * Confirms the payment to the buyer. Driven off the checkout session (which
 * carries the customer email and the period end) rather than a later
 * subscription event, so the receipt fires exactly once per purchase. Best-
 * effort: a mail outage must not turn a paid, already-synced checkout into a
 * failed webhook — Stripe would retry and re-run the sync.
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

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && typeof session.subscription === "string") {
        const sub = await getStripe().subscriptions.retrieve(session.subscription);
        await syncSubscriptionFromStripe(sub);
        await sendReceipt(session);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const stripeSub = event.data.object as Stripe.Subscription;
      await syncSubscriptionFromStripe(stripeSub);
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
      }
      break;
    }
    default:
      console.log(`[billing] unhandled event: ${event.type}`);
  }

  return NextResponse.json({ received: true });
}