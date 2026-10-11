import { NextResponse } from "next/server";
import { createCheckoutSession, PRICES, sameOriginReturnUrl } from "@/lib/stripe";
import { getSession } from "@/lib/session";

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

  try {
    const url = await createCheckoutSession(session.workspaceId, priceId as keyof typeof PRICES, ret);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] checkout error:", err);
    return NextResponse.json({ error: "Could not create checkout session" }, { status: 500 });
  }
}
