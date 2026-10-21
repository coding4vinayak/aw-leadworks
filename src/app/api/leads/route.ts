import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { intParam, pageParams } from "@/lib/pagination";
import { asStrings, missingIds, unknownIdsError } from "@/lib/ids";
import { validateBody, readJson } from "@/lib/validate";
import { LEAD_CREATE } from "@/lib/fields";
import { scoredWriteData } from "@/lib/lead-score";
import { dispatchWebhookEvent } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const listId = searchParams.get("listId");
  const status = searchParams.get("status");
  const minScore = intParam(searchParams, "minScore", 0, 0, 100);
  const maxScore = intParam(searchParams, "maxScore", 100, 0, 100);
  const { page, limit } = pageParams(searchParams, 50);


  const where: any = { workspaceId };
  if (listId) where.listMemberships = { some: { listId } };
  if (status) where.status = status;
  if (minScore > 0) where.score = { ...where.score, gte: minScore };
  if (maxScore < 100) where.score = { ...where.score, lte: maxScore };

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: { listMemberships: { include: { list: true } }, _count: { select: { activities: true, enrichmentLogs: true } } },
      orderBy: { score: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.lead.count({ where }),
  ]);

  return NextResponse.json({ leads, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, LEAD_CREATE);
  if (!input.ok) return input.error;

  if (!input.data.email && !input.data.phone && !input.data.linkedinUrl) {
    return NextResponse.json({ error: "at least one contact method required" }, { status: 400 });
  }

  // Every list the caller names has to exist here, or the lead is created
  // outside all of them and silently misses every campaign keyed to those
  // lists. That is the same silent-miss failure the nested write below exists
  // to prevent, so it is checked at the boundary rather than left to a P2003.
  const lists = asStrings(body.listIds, "listIds");
  if (lists.error) return lists.error;
  if (lists.values.length) {
    const found = await prisma.leadList.findMany({ where: { workspaceId, id: { in: lists.values } }, select: { id: true } });
    const missing = missingIds(lists.values, found);
    if (missing.length) return unknownIdsError("listIds", missing);
  }

  // The list memberships commit with the lead or not at all: a 201 that left
  // the lead outside every list the caller named is a record that silently
  // misses every campaign keyed to those lists. One nested write does that; an
  // interactive $transaction also does but is a SQLite write-lock queue that
  // collapses under concurrent writers (2.5 rps at c=10, mostly P1008 timeouts).
  const lead = await prisma.lead.create({
    data: {
      workspaceId,
      ...input.data,
      // Required Json columns: an absent `tags` is not written by the table
      // above, and the column has no default, so a lead with no tags still needs
      // the array here. `mergeLeads` in `dedupe.ts` spreads all three.
      technologies: input.data.technologies ?? [],
      intentSignals: input.data.intentSignals ?? [],
      tags: input.data.tags ?? [],
      status: "NEW",
      // `LEAD_CREATE` has no `score`, so a created lead used to sit at the column
      // default of 0 while the dashboard and `orderBy: { score: "desc" }` ranked
      // buyers by it. The row's own signals are the only thing a score comes from,
      // and they are all present here, so it is computed before the insert rather
      // than written by a second round trip.
      ...scoredWriteData(input.data),
      ...(lists.values.length
        ? { listMemberships: { create: lists.values.map((listId: string) => ({ listId })) } }
        : {}),
    },
  });

  await dispatchWebhookEvent(workspaceId, "lead.created", { lead });

  return NextResponse.json(lead, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
