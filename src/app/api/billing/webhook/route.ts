import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, verifyWebhook, syncSubscriptionFromStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

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