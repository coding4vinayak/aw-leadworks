import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Request-ID propagation for every /api call.
 *
 * Send `x-request-id` and it echoes back; omit it and we mint one.
 * Support incidents become greppable: one id ties the access log,
 * the error log, and the customer's report together. No auth, no
 * behavior change — just a header in both directions.
 */
export function middleware(request: NextRequest) {
  const id =
    request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", id);
  return res;
}

export const config = { matcher: "/api/:path*" };
