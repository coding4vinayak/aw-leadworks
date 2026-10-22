import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { readJson, validateBody } from "@/lib/validate";
import { SOURCE_CREATE } from "@/lib/fields";
import { scheduleProblem } from "@/lib/cron-schedule";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const isActive = searchParams.get("isActive");
  const { page, limit } = pageParams(searchParams, 20);


  const where: any = { workspaceId };
  if (isActive !== null) where.isActive = isActive === "true";

  const [sources, total] = await Promise.all([
    prisma.source.findMany({
      where,
      include: { _count: { select: { jobs: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.source.count({ where }),
  ]);

  return NextResponse.json({ sources, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  // `isActive: isActive ?? true` and the `!config` guard were the whole check
  // before: the type of every field was the database's problem, and Prisma
  // answers a wrong one with a validation error, which is a 500. Absent
  // `isActive` still means true — that is the column's own `@default`.
  const input = validateBody(body, SOURCE_CREATE);
  if (!input.ok) return input.error;

  // A cadence no minute can equal is not a slower schedule — it is no schedule, and this
  // column takes any 64 characters. #38 measured `*/5 * * * *` stored with a 201, minting
  // zero `Job` rows across four sweep minutes that contained two of its fifth-minutes, while
  // `POST /api/enrichment-rules` refused the identical string with a 400. The refusal is the
  // matcher's own grammar, imported rather than re-spelled, so the door and the minute that
  // reads it cannot drift into disagreeing about what a cron means here.
  if (typeof input.data.schedule === "string") {
    const unreadable = scheduleProblem(input.data.schedule);
    if (unreadable !== null) return NextResponse.json({ error: unreadable }, { status: 400 });
  }

  const source = await prisma.source.create({ data: { workspaceId, ...input.data } });

  return NextResponse.json(source, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
