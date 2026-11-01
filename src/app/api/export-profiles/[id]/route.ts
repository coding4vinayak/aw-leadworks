import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { profileSweep } from "@/lib/export-profile";

export const dynamic = "force-dynamic";

/**
 * GET /api/export-profiles/{id}
 *
 * One profile, the same `sweep` verdict the list prints and the sweep acts on, and the
 * exports it has run. Another workspace's row is refused with the app's not-found `404`, not a
 * `403` naming an owner it could probe: `assertOwns` answers `404 / 22 {"error":"Not found."}` and
 * the missing-row branch above answers `404 / 21 {"error":"Not found"}` — measured on this build
 * (`q87_press_fix.log`, `:3471` over `leadworks_q87`). Those two bytes are trunk's own pair, the
 * same pair every `[id]` door gives, so what a caller walking ids cannot learn from this door is
 * which workspace holds the row it found.
 */
async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await prisma.exportProfile.findUnique({
    where: { id },
    include: {
      _count: { select: { exports: true } },
      exports: { orderBy: { createdAt: "desc" as const }, take: 5, select: { id: true, status: true, format: true, recordCount: true, createdAt: true } },
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, row.workspaceId);

  const { exports, _count, ...rest } = row;
  return NextResponse.json({ ...rest, exportsCount: _count.exports, sweep: profileSweep(rest, new Date()), recentExports: exports });
}

export const GET = withAuth(GET_impl);
