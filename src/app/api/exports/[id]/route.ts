import { NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { enqueueJob, QueueUnavailableError } from "@/lib/queue";
import { markExportNeverQueued, markNeverQueued } from "@/lib/queue-refusal";
import { planRowDelete, retentionVerdict, retiredExportError } from "@/lib/export-retention";

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
        // The queue refused this row, so the row says so: left at `PENDING` it is a job no
        // worker will run and no door will resume — `retryAsk` answers 409 for it, "it will run".
        await markNeverQueued(job.id);
        await markExportNeverQueued(id);
        return NextResponse.json({ error: error.message, jobId: job.id }, { status: error.status });
      }
      throw error;
    }

    return NextResponse.json({ jobId: job.id });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

/**
 * #37 — deleting an export's record deletes the file it named, in the same request.
 *
 * The row goes first, deliberately. The two ways this can half-finish are not equal: a row
 * outliving its file is a download door pointing at nothing, which is the failure the app
 * already had when the operating system reclaimed `/tmp` on its own and the reason a second 410
 * sentence exists; a file outliving its row is the state `/tmp` is already in, counted every
 * minute by the sweep's census and worth nobody's data loss. So this door takes the record, then
 * acts on `planRowDelete` — the same shape guard the purge uses, on the `filePath` read *before*
 * the delete, never on a path the caller supplied — and says plainly in the response which of
 * `removed` / `already gone from this server` / `left on disk` happened. An `ENOENT` is a fact
 * about `/tmp`, not a failure. Any other error is logged with its reason and named in the
 * response, because `{ ok: true }` over a file that is still there is the over-claim this round
 * exists to remove.
 */
async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.export.findUnique({
    where: { id },
    select: { workspaceId: true, filePath: true },
  });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  await prisma.export.delete({ where: { id } });

  const plan = planRowDelete(_owned.filePath);
  if (plan.action === "none") return NextResponse.json({ ok: true, file: plan.reason });
  try {
    await unlink(plan.filePath);
    return NextResponse.json({ ok: true, file: "removed" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: true, file: "already gone from this server" });
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Export ${id}: row deleted, file at ${plan.filePath} not removed — ${reason}`);
    return NextResponse.json({ ok: true, file: "left on disk", fileError: reason });
  }
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
