import { NextResponse } from "next/server";
import { openapiSpec } from "@/lib/openapi";

export const dynamic = "force-dynamic";

/**
 * The contract, at the versioned path.
 *
 * Unauthenticated on purpose: a contract is a description, not data, and an
 * integrator should be able to read it before it has a key. The spec is
 * generated from `src/lib/openapi.ts`, and `scripts/check-contract.mts`
 * checks that file against the route handlers — every operation here has a
 * route that answers, every route that answers is in here, and every request
 * body matches the app's own declared field table.
 */
export async function GET() {
  return new NextResponse(JSON.stringify(openapiSpec, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
