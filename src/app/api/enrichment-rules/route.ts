import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { asInputJson } from "@/lib/json";
import { readJson, validateBody } from "@/lib/validate";
import { RULE_CREATE } from "@/lib/fields";
import { conditionsProblem, normalizeConditions } from "@/lib/rule-conditions";
import { normalizeActions, ruleDeclarationProblem } from "@/lib/rule-actions";
import { normalizeProviders, providersProblem } from "@/lib/enrichment-providers";

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

  // `kind: "json"` already refused `42`; nothing refused `{ department: "Ops" }`,
  // which is a valid object and a filter no lead can ever satisfy — the rule would
  // sit active and enrich nobody, forever, looking like a quiet week.
  const problem = conditionsProblem(input.data.conditions);
  if (problem !== null) return NextResponse.json({ error: problem }, { status: 400 });

  // The same argument about the other half of the rule: `kind: "strings"` proves
  // `providers` is a list of words, and proves nothing about whether any worker
  // will answer one of them.
  const providerProblem = providersProblem(input.data.providers);
  if (providerProblem !== null) return NextResponse.json({ error: providerProblem }, { status: 400 });

  // And the third half, which the schema spells "what enrichment to perform" and
  // which nothing used to read: `{ enrich: ["companySize"] }` is a valid JSON object
  // and a declaration no build performs, and a SCHEDULED rule without a cadence the
  // sweep can match is stored active and never runs.
  const declaredProblem = ruleDeclarationProblem(input.data.trigger, input.data.actions);
  if (declaredProblem !== null) return NextResponse.json({ error: declaredProblem }, { status: 400 });

  const rule = await prisma.enrichmentRule.create({
    data: {
      workspaceId,
      ...input.data,
      conditions: asInputJson(normalizeConditions(input.data.conditions)),
      actions: asInputJson(normalizeActions(input.data.actions)),
      providers: asInputJson(normalizeProviders(input.data.providers)),
    },
  });

  return NextResponse.json(rule, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
