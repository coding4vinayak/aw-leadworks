import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { readJson, validateBody } from "@/lib/validate";
import { LEAD_LIST_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const { page, limit } = pageParams(searchParams, 20);


  const [lists, total] = await Promise.all([
    prisma.leadList.findMany({
      where: { workspaceId },
      include: { _count: { select: { members: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.leadList.count({ where: { workspaceId } }),
  ]);

  return NextResponse.json({ lists, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  // `!!isDynamic` was the whole check before: `isDynamic: "yes"` and
  // `isDynamic: "no"` both stored true, because a non-empty string is truthy.
  const input = validateBody(body, LEAD_LIST_CREATE);
  if (!input.ok) return input.error;

  const list = await prisma.leadList.create({ data: { workspaceId, ...input.data } });
  return NextResponse.json(list, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
