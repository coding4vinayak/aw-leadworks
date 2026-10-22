import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { readJson, validateBody } from "@/lib/validate";
import { JOB_PATCH } from "@/lib/fields";
import { jobReport } from "@/lib/job-report";
import { enqueueJob, hasRunner, QueueUnavailableError } from "@/lib/queue";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    include: { source: true, results: { orderBy: { createdAt: "desc" }, take: 50 } },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, job.workspaceId);
  // `results` is the newest 50 of them, which is not the same question as how many
  // there are. Counted, so a caller can tell 50 of 50 from 50 of 4,000 — and so the
  // row's own percentages are read as arithmetic with a denominator next to it.
  const recorded = await prisma.jobResult.count({ where: { jobId: id } });
  return NextResponse.json({ ...job, report: jobReport(job, recorded, job.results.length) });
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;

  const _owned = await prisma.job.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  const input = validateBody(raw.body, JOB_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  const job = await prisma.job.update({ where: { id }, data: input.data });
  return NextResponse.json(job);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, job.workspaceId);

  if (action === "retry") {
    if (job.status !== "FAILED" && job.status !== "COMPLETED") {
      return NextResponse.json({ error: "Can only retry failed or completed jobs" }, { status: 400 });
    }
    // Before the insert, so a type with no worker does not leave a second
    // PENDING row behind that nothing will ever pick up.
    if (!hasRunner(job.type)) {
      return NextResponse.json({ error: `nothing runs a job of type ${job.type}; it cannot be retried` }, { status: 409 });
    }
    const newJob = await prisma.job.create({
      data: { workspaceId: job.workspaceId, ...(job.sourceId && { sourceId: job.sourceId }), type: job.type, config: asInputJson(job.config), status: "PENDING" },
    });
    try {
      await enqueueJob(job.type, newJob.id);
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    return NextResponse.json({ jobId: newJob.id });
  }

  if (action === "cancel") {
    if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
      return NextResponse.json({ error: "Cannot cancel completed job" }, { status: 400 });
    }
    await prisma.job.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.job.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.job.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
