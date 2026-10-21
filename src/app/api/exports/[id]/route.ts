import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { enqueueJob, QueueUnavailableError } from "@/lib/queue";
import { retentionVerdict, retiredExportError } from "@/lib/export-retention";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const exportRecord = await prisma.export.findUnique({
    where: { id },
    include: { profile: true },
  });
  if (!exportRecord) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, exportRecord.workspaceId);
  return NextResponse.json(exportRecord);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  // One lookup, one ownership check, before either action reads the row. The
  // download branch used to sit above the only `assertOwns` in this handler, so
  // measured with no Authorization header at all it answered
  // `{downloadUrl:"/api/exports/<id>/download"}` for any export id in any
  // workspace — and that URL is the route that streams the file.
  const exportRecord = await prisma.export.findUnique({ where: { id } });
  if (!exportRecord) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, exportRecord.workspaceId);

  if (action === "download") {
    if (!exportRecord.filePath) return NextResponse.json({ error: "File not found" }, { status: 404 });
    // The same verdict the streaming route asks, from the same module: this door
    // used to answer with a URL to a file it had already agreed to stop serving,
    // so the caller's next request was where they learned. A retired export is
    // refused here with the sentence the streaming route would have given it.
    if (retentionVerdict(exportRecord.expiresAt) === "retired") {
      return NextResponse.json({ error: retiredExportError(exportRecord.expiresAt) }, { status: 410 });
    }
    return NextResponse.json({ downloadUrl: `/api/exports/${id}/download` });
  }

  if (action === "retry") {
    if (exportRecord.status !== "FAILED") {
      return NextResponse.json({ error: "Can only retry failed exports" }, { status: 400 });
    }

    const job = await prisma.job.create({
      data: {
        workspaceId: exportRecord.workspaceId,
        type: "EXPORT",
        status: "PENDING",
        config: { format: exportRecord.format, fields: asInputJson(exportRecord.fields), filterJson: asInputJson(exportRecord.filterJson), exportId: exportRecord.id },
      },
    });

    // `jobId` moves with the status: the row already records the job that
    // produced it, and leaving it pointing at the failed one makes
    // `GET /api/exports/[id]` describe a job that is not this export's.
    await prisma.export.update({ where: { id }, data: { status: "PENDING", jobId: job.id } });
    try {
      await enqueueJob("EXPORT", job.id);
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
  const _owned = await prisma.export.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.export.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
