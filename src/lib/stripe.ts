/**
 * Stripe integration for LeadWorks — $49/month flat.
 */
import Stripe from "stripe";
import { prisma } from "./db";

// Lazy client: importing this module must never throw (builds, unit tests,
// and routes that only verify webhooks run without a key configured).
let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!_stripe) {
    _stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", typescript: true });
  }
  return _stripe;
}

export const PRICES = {
  FLAT_MONTHLY: process.env.STRIPE_PRICE_FLAT_MONTHLY ?? "price_flat_monthly",
  FLAT_ANNUAL: process.env.STRIPE_PRICE_FLAT_ANNUAL ?? "price_flat_annual",
} as const;

export const SUBSCRIPTION_STATUS_ACTIVE = ["trialing", "active", "past_due"] as const;

export async function ensureCustomer(workspaceId: string, email: string, name: string) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, subscription: { select: { stripeCustomerId: true } } },
  });
  if (!ws) throw new Error("Workspace not found");

  if (ws.subscription?.stripeCustomerId) return ws.subscription.stripeCustomerId;

  const customer = await getStripe().customers.create({
    email,
    name: ws.name ?? name,
    metadata: { workspaceId },
  });
  await prisma.subscription.create({
    data: { workspaceId, stripeCustomerId: customer.id, status: "incomplete" },
  });
  return customer.id;
}

/**
 * Stripe sends the customer back to return_url after payment, so whatever a
 * caller puts there is a redirect away from this app on a page that has just
 * handled their card. Only a URL on this deployment's own origin is accepted,
 * and an unset NEXT_PUBLIC_APP_URL fails closed rather than guessing.
 */
export function sameOriginReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return null;
  try {
    const target = new URL(raw);
    if (target.origin !== new URL(appUrl).origin) return null;
    return target.toString();
  } catch {
    return null;
  }
}

export async function createCheckoutSession(workspaceId: string, priceId: keyof typeof PRICES, returnUrl: string) {  const customerId = await ensureCustomer(workspaceId, "", "");
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: PRICES[priceId], quantity: 1 }],
    allow_promotion_codes: true,
    billing_address_collection: "required",
    subscription_data: { metadata: { workspaceId }, trial_period_days: 14 },
    success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: returnUrl,
  });
  return session.url;
}

export async function createPortalSession(workspaceId: string, returnUrl: string) {
  const sub = await prisma.subscription.findUnique({ where: { workspaceId } });
  if (!sub?.stripeCustomerId) throw new Error("No Stripe customer for this workspace");
  const session = await getStripe().billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

export function verifyWebhook(rawBody: string, signature: string | null) {
  if (!signature) throw new Error("Missing Stripe signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  // constructEvent is pure HMAC — it never touches the network, so
  // verification works without an API key (builds, unit tests).
  const client = process.env.STRIPE_SECRET_KEY
    ? getStripe()
    : new Stripe("sk_webhook_verify_only", { apiVersion: "2026-09-30.endive" });
  return client.webhooks.constructEvent(rawBody, signature, secret);
}

export async function syncSubscriptionFromStripe(stripeSub: Stripe.Subscription) {
  const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
  if (!workspaceId) return;

  const status = stripeSub.status;
  const itemPeriodEnd = stripeSub.items.data[0]?.current_period_end;
  const periodEnd = typeof itemPeriodEnd === "number" ? new Date(itemPeriodEnd * 1000) : null;

  await prisma.subscription.upsert({
    where: { workspaceId },
    update: {
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: stripeSub.items.data[0]?.price.id,
      stripeCurrentPeriodEnd: periodEnd,
      status,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    },
    create: {
      workspaceId,
      stripeCustomerId: stripeSub.customer as string,
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: stripeSub.items.data[0]?.price.id,
      stripeCurrentPeriodEnd: periodEnd,
      status,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    },
  });
}

export async function hasActiveSubscription(workspaceId: string): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({
    where: { workspaceId },
    select: { status: true },
  });
  return sub ? (SUBSCRIPTION_STATUS_ACTIVE as readonly string[]).includes(sub.status) : false;
}