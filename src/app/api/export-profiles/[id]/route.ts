import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { profileSweep } from "@/lib/export-profile";

export const dynamic = "force-dynamic";

/**
 * GET /api/export-profiles/{id}
 *
 * One profile, the same `sweep` verdict the list prints and the sweep acts on, and the
 * exports it has run. Another workspace's row is answered exactly as a row that is not there
 * at all — `assertOwns` makes the two the same 404 on purpose, so a caller cannot walk ids
 * and find out which tenant holds them.
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
