import { NextResponse } from "next/server";
import {
  createCheckoutSession,
  PRICES,
  sameOriginReturnUrl,
  SUBSCRIPTION_STATUS_OPEN,
} from "@/lib/stripe";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * This used to take workspaceId from the query string with no authentication
 * whatsoever, so an anonymous caller could open a Stripe checkout session for
 * any workspace — the 404-versus-200 answer doubles as a way to enumerate which
 * ids exist — and `ensureCustomer` would happily create a Stripe customer for a
 * tenant that never asked for one. The workspace now comes from the signed-in
 * session, which is the only source of it a route should trust.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const { priceId, returnUrl } = body as { priceId?: unknown; returnUrl?: unknown };

  if (typeof priceId !== "string" || !(priceId in PRICES)) {
    return NextResponse.json({ error: `priceId must be one of ${Object.keys(PRICES).join(", ")}` }, { status: 400 });
  }
  const ret = sameOriginReturnUrl(returnUrl);
  if (!ret) return NextResponse.json({ error: "returnUrl must be a page on this site" }, { status: 400 });

  // A second checkout is a second subscription. Stripe keeps charging the first
  // one — nothing here cancels it, and the local row is keyed by workspace, so
  // it ends up describing the newer of the two while the older invoice carries
  // on arriving. That is a refund conversation at best and a chargeback at
  // worst, and it is the buyer's last impression of the product. Changing what
  // you pay for is the portal's job, and the portal is where a card that is
  // failing gets fixed before Stripe cancels on its own. The refusal set is
  // wider than "has access": `unpaid` is a subscription whose dunning ran out,
  // with an open invoice the portal can settle — a new checkout pays neither.
  // `incomplete` is deliberately allowed: it never charged and Stripe expires
  // it on its own, and starting over is how a declined card tries again.
  const current = await prisma.subscription.findUnique({
    where: { workspaceId: session.workspaceId },
    select: { status: true },
  });
  if (current && (SUBSCRIPTION_STATUS_OPEN as readonly string[]).includes(current.status)) {
    return NextResponse.json(
      {
        error:
          `This workspace is already on a ${current.status} plan. Switch plan or fix the card in the ` +
          "billing portal — a second checkout would be a second subscription, and a second invoice.",
      },
      { status: 409 },
    );
  }

  try {
    const url = await createCheckoutSession(session.workspaceId, priceId as keyof typeof PRICES, ret);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] checkout error:", err);
    return NextResponse.json({ error: "Could not create checkout session" }, { status: 500 });
  }
}
