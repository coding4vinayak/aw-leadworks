import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { importLeadCsv, MAX_IMPORT_BYTES } from "@/lib/csv-import";
import { readJson, validateBody } from "@/lib/validate";
import { LEAD_IMPORT } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * `POST /api/leads/import` — the list the buyer already has.
 *
 * Two content types, one importer: `text/csv` for `curl --data-binary` and a
 * JSON `{ "csv": "..." }` body for clients that only speak JSON. The API key
 * decides the workspace (an optional `workspaceId` is checked by the same claim
 * rule as every other route).
 */
async function POST_impl(request: Request) {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  // Refuse an oversized upload before buffering it. A chunked body without a
  // length is still checked after the read, below.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    return NextResponse.json(
      { error: `request is ${declared} bytes; the limit is ${MAX_IMPORT_BYTES}` },
      { status: 413 },
    );
  }
  let csv: string;
  let workspaceId: string;

  if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
    csv = await request.text();
    workspaceId = await authedWorkspaceId(request);
  } else {
    const raw = await readJson(request);
    if (!raw.ok) return raw.error;
    const body = raw.body as Record<string, unknown>;
    workspaceId = await authedWorkspaceId(request, body.workspaceId);
    const input = validateBody(body, LEAD_IMPORT);
    if (!input.ok) return input.error;
    csv = input.data.csv;
  }

  const bytes = Buffer.byteLength(csv, "utf8");
  if (bytes > MAX_IMPORT_BYTES) {
    return NextResponse.json(
      { error: `csv is ${bytes} bytes; the limit is ${MAX_IMPORT_BYTES}` },
      { status: 413 },
    );
  }

  const result = await importLeadCsv(workspaceId, csv);
  if (result.parseError) {
    return NextResponse.json(
      { error: result.parseError.message, line: result.parseError.line },
      { status: 422 },
    );
  }
  // 201 only when something was created; a file that was entirely duplicates or
  // invalid rows is a successful request with a report, not a new resource.
  return NextResponse.json(result, { status: result.imported > 0 ? 201 : 200 });
}

export const POST = withAuth(POST_impl);
