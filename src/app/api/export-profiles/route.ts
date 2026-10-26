import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { profileSweep } from "@/lib/export-profile";
import { pageParams } from "@/lib/pagination";

export const dynamic = "force-dynamic";

/**
 * GET /api/export-profiles?workspaceId=&page=&limit=
 *
 * The profiles the sweep reads and `GET /api/exports?profileId=` filters by, which until
 * this round no door could list: a caller was refused a `profileId` this workspace does not
 * have and had no way to learn the ones it does, while the only writer of the table in the
 * repository was `prisma/seed.ts`.
 *
 * Every row carries `sweep` — the verdict `src/lib/export-profile.ts` computes and
 * `scheduler.ts` acts on this minute, the same function, so a profile whose cadence no
 * minute can match reads `unreadable` here instead of existing only in the server's log.
 * `exportsCount` is what the row has already produced, which is how "active since Monday and
 * has never emitted a file" is answerable at all.
 *
 * No door writes this table yet: `POST`, `PATCH` and `DELETE` on these paths stay 404 and the
 * contract says so. The rows are what the demo seed and a direct database write make.
 */
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const { page, limit } = pageParams(searchParams, 20);

  const where = { workspaceId };
  const window = { where, orderBy: { createdAt: "desc" as const }, skip: (page - 1) * limit, take: limit };
  const [rows, total] = await Promise.all([
    prisma.exportProfile.findMany({ ...window, include: { _count: { select: { exports: true } } } }),
    prisma.exportProfile.count({ where }),
  ]);

  const now = new Date();
  // `_count` is Prisma's shape; the door prints the name the contract uses, and drops the
  // wrapper so a caller is not handed the same number twice under two keys.
  const profiles = rows.map(({ _count, ...one }) => ({ ...one, exportsCount: _count.exports, sweep: profileSweep(one, now) }));
  return NextResponse.json({ profiles, total, page, limit, totalPages: Math.ceil(total / limit) });
}

export const GET = withAuth(GET_impl);
