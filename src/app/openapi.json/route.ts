import { GET as contract } from "../api/openapi/route";

export const dynamic = "force-dynamic";

/**
 * The conventional discovery path. `/api/openapi` is the versioned home of the
 * document; this calls that exact handler, so the two can never tell an
 * integrator (or a crawler) different stories. API tooling probes
 * `/openapi.json` first — a 404 there reads as "no contract" even when the
 * versioned path is perfect.
 *
 * It calls the handler rather than re-exporting it because the route scanner
 * behind `tests/unit/route-auth.test.ts` reads handlers out of their own
 * file, and a re-export names a function in another one. The two paths still
 * answer from the same code, which is the point of the alias.
 */
export async function GET() {
  return contract();
}
