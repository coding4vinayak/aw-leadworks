import { NextResponse } from "next/server";
import { createPortalSession, sameOriginReturnUrl } from "@/lib/stripe";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The worst of the two: unauthenticated, it handed back a Stripe billing-portal
 * URL for whatever workspaceId was in the query string, and that portal is where
 * a customer changes their card, cancels the subscription and reads invoices. So
 * an anonymous caller with a guessed id could manage another tenant's billing.
 * The id now comes from the session and nothing else.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  const { returnUrl } = body as { returnUrl?: unknown };

  const ret = sameOriginReturnUrl(returnUrl);
  if (!ret) return NextResponse.json({ error: "returnUrl must be a page on this site" }, { status: 400 });

  try {
    const url = await createPortalSession(session.workspaceId, ret);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] portal error:", err);
    return NextResponse.json({ error: "Could not create portal session" }, { status: 500 });
  }
}
