import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { readFile, stat } from "node:fs/promises";
import { prisma } from "@/lib/db";
import {
  MISSING_EXPORT_FILE_ERROR,
  retentionVerdict,
  retiredExportError,
} from "@/lib/export-retention";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  CSV: "text/csv",
  JSON: "application/json",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PDF: "application/pdf",
};

/**
 * GET /api/exports/[id]/download — stream the finished export file.
 *
 * This route existed only as a URL string in the ?action=download response:
 * customers got a link that 404'd. Now it streams the worker-written file
 * with the right content type and an attachment filename. Missing or
 * unfinished exports 404 with a reason instead of an HTML page.
 *
 * Two 410s, and they mean different things: the row's own `expiresAt` (round
 * #35) retires an export by date — its bytes may still be on disk — while a
 * file the machine reclaimed is an accident that happened to have no date
 * behind it. The retention check runs first, before the file is opened, so a
 * refused-by-policy export is refused by policy and is never reported as a
 * lost file, and the two sentences stay distinguishable to whoever has to
 * act on them.
 */
async function GET_impl(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await prisma.export.findUnique({ where: { id } });
  if (!record) return NextResponse.json({ error: "export not found" }, { status: 404 });
  await assertOwns(_request, record.workspaceId);
  if (record.status !== "COMPLETED" || !record.filePath) {
    return NextResponse.json(
      { error: `export is ${record.status.toLowerCase()} — download unlocks when it completes` },
      { status: 404 },
    );
  }
  const verdict = retentionVerdict(record.expiresAt);
  if (verdict === "retired") {
    return NextResponse.json({ error: retiredExportError(record.expiresAt) }, { status: 410 });
  }
  let bytes: Buffer;
  try {
    const st = await stat(record.filePath);
    if (!st.isFile()) throw new Error("not a file");
    bytes = await readFile(record.filePath);
  } catch {
    return NextResponse.json({ error: MISSING_EXPORT_FILE_ERROR }, { status: 410 });
  }
  const ext = (record.format || "csv").toLowerCase();
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": MIME[record.format] ?? "application/octet-stream",
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="leadworks-export-${record.id}.${ext}"`,
    },
  });
}

export const GET = withAuth(GET_impl);
