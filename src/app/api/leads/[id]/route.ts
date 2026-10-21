import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { readJson, validateBody } from "@/lib/validate";
import { rowAfterWrite, scoredWriteData } from "@/lib/lead-score";
import { LEAD_ADD_TO_LIST, LEAD_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      listMemberships: { include: { list: true } },
      enrichmentLogs: { orderBy: { createdAt: "desc" }, take: 10 },
      activities: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!lead) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, lead.workspaceId);
  return NextResponse.json(lead);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;

  const before = await prisma.lead.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, before.workspaceId);

  // The three array columns are spread by mergeLeads, so a scalar accepted here
  // becomes a 500 in some later merge, and each field is only touched when the
  // caller sent it: an absent key must not become an empty array, or a PATCH
  // that renames a lead would silently wipe its tags. `requireWrite` is the
  // other half — an update whose data holds nothing returns the row untouched,
  // which measured as a 200 that had changed nothing.
  const input = validateBody(raw.body, LEAD_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;

  // A person's `score` lands in `scoreOverride`, never in `Lead.score`: the
  // number the whole app sorts by is computed by `lib/lead-score.ts` from this
  // row, of which the override is one input. The response carries both the 82
  // someone typed and the 44 the row's signals earned, because a buyer who asks
  // "why is this at the top of my list?" is owed the difference, not a number
  // that hides it. `score: null` gives the override back and the score falls to
  // the arithmetic.
  const { score, ...fields } = input.data;
  const scoreOverride = score === undefined ? before.scoreOverride : score;
  const lead = await prisma.lead.update({
    where: { id },
    data: {
      ...fields,
      scoreOverride,
      ...scoredWriteData(rowAfterWrite(before, { ...fields, scoreOverride })),
    },
  });
  return NextResponse.json(lead);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "enrich") {
    const _owned = await prisma.lead.findUnique({ where: { id }, select: { workspaceId: true } });
    if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertOwns(request, _owned.workspaceId);
    const job = await prisma.job.create({
      data: {
        workspaceId: _owned.workspaceId,
        type: "ENRICH",
        status: "PENDING",
        config: { providers: ["apollo", "clearbit", "hunter"], fields: [], confidenceThreshold: 0.5 },
      },
    });
    try {
      await enqueue(queues.enrich, "run-enrichment", { jobId: job.id });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    return NextResponse.json({ jobId: job.id });
  }

  if (action === "add-to-list") {
    const raw = await readJson(request);
    if (!raw.ok) return raw.error;
    // `!listId` alone lets 42 and {id: "..."} through to Prisma, which answers
    // with a validation error and the caller gets a 500 for sending the wrong
    // type.
    const input = validateBody(raw.body, LEAD_ADD_TO_LIST);
    if (!input.ok) return input.error;
    const listId = input.data.listId;
    const _owned = await prisma.lead.findUnique({ where: { id }, select: { workspaceId: true } });
    if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertOwns(request, _owned.workspaceId);
    const list = await prisma.leadList.findUnique({ where: { id: listId }, select: { workspaceId: true } });
    if (!list) return NextResponse.json({ error: "List not found" }, { status: 404 });
    await assertOwns(request, list.workspaceId);
    await prisma.leadListMember.create({ data: { listId, leadId: id } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.lead.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.lead.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
