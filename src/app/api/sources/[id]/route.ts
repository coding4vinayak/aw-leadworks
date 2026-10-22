import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody } from "@/lib/validate";
import { SOURCE_PATCH } from "@/lib/fields";
import { scheduleProblem } from "@/lib/cron-schedule";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = await prisma.source.findUnique({
    where: { id },
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 10 }, _count: { select: { jobs: true } } },
  });
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, source.workspaceId);
  return NextResponse.json(source);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;

  const _owned = await prisma.source.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  const input = validateBody(raw.body, SOURCE_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  // The edit door refuses what the create door refuses: `null` still means "no cadence",
  // and a cadence the sweep cannot match means the same thing said in a way the operator
  // would have to discover from an empty schedule.
  if (typeof input.data.schedule === "string") {
    const unreadable = scheduleProblem(input.data.schedule);
    if (unreadable !== null) return NextResponse.json({ error: unreadable }, { status: 400 });
  }
  const source = await prisma.source.update({ where: { id }, data: input.data });
  return NextResponse.json(source);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "run") {
    const source = await prisma.source.findUnique({ where: { id }, select: { workspaceId: true, config: true } });
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
    await assertOwns(request, source.workspaceId);

    const job = await prisma.job.create({
      data: {
        // `|| ""` was noise: workspaceId is a required column, and an empty one
        // would have made this a job belonging to no workspace (a foreign-key
        // violation, i.e. a 500) rather than anything worth falling back to.
        workspaceId: source.workspaceId,
        sourceId: id,
        type: "SCRAPE",
        status: "PENDING",
        config: source.config ?? {},
      },
    });
    try {
      await enqueue(queues.scrape, "run-scrape", { jobId: job.id });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    return NextResponse.json({ jobId: job.id });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.source.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.source.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
