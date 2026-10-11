import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { readJson, validateBody } from "@/lib/validate";
import { RULE_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const isActive = searchParams.get("isActive");
  const { page, limit } = pageParams(searchParams, 20);


  const where: any = { workspaceId };
  if (isActive !== null) where.isActive = isActive === "true";

  const [rules, total] = await Promise.all([
    prisma.enrichmentRule.findMany({
      where,
      include: { _count: { select: { logs: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.enrichmentRule.count({ where }),
  ]);

  return NextResponse.json({ rules, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, RULE_CREATE);
  if (!input.ok) return input.error;

  const rule = await prisma.enrichmentRule.create({
    data: { workspaceId, ...input.data },
  });

  return NextResponse.json(rule, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
