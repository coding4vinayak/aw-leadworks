import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { pageParams } from "@/lib/pagination";
import { readJson, validateBody } from "@/lib/validate";
import { EXPORT_CREATE } from "@/lib/fields";
import { unknownIdError } from "@/lib/ids";
import { filterParam } from "@/lib/list-filter";
import { exportFilterProblem } from "@/lib/export-format";
import { EXPORT_STATUSES } from "@/lib/enums";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const profileId = searchParams.get("profileId");
  // `EXPORT_STATUSES` is the set the schema comment gives this column and the set
  // `exporter.ts` writes — including PROCESSING, which no table in `enums.ts`
  // declared until now. `RUNNING` is a Job word; asked of this door it used to be
  // a 200 and an empty page.
  const status = filterParam(searchParams, "status", EXPORT_STATUSES);
  if (status.error) return status.error;
  const { page, limit } = pageParams(searchParams, 20);


  const where: any = { workspaceId };
  if (profileId) where.profileId = profileId;
  if (status.value) where.status = status.value;

  const [exports, total] = await Promise.all([
    prisma.export.findMany({
      where,
      include: { profile: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.export.count({ where }),
  ]);

  return NextResponse.json({ exports, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);
  // Format names are case-insensitive ("csv" works like "CSV"): the worker
  // switch is exact-match, and a FAILED export is worse than a guess.
  if (typeof body.format === "string") body.format = body.format.toUpperCase();

  const input = validateBody(body, EXPORT_CREATE);
  if (!input.ok) return input.error;

  // A profile the caller does not have used to reach Prisma as a foreign key
  // and come back as P2003 — a 500 that names no field.
  if (input.data.profileId) {
    const found = await prisma.exportProfile.findMany({
      where: { workspaceId, id: input.data.profileId },
      select: { id: true },
    });
    if (!found.length) return unknownIdError("profileId", input.data.profileId);
  }

  // And the filter, which is the crowd the file will hold. The worker reads it
  // with `readExportFilter`; the door read nothing, so a word outside `Lead.status`
  // was stored, run against no lead, and reported itself COMPLETED with an empty
  // file. Same question, asked before the row exists.
  const filterProblem = exportFilterProblem(input.data.filterJson);
  if (filterProblem !== null) return NextResponse.json({ error: filterProblem }, { status: 400 });

  const exportRecord = await prisma.export.create({
    data: { workspaceId, ...input.data, status: "PENDING" },
  });

  const job = await prisma.job.create({
    data: {
      workspaceId,
      type: "EXPORT",
      status: "PENDING",
      config: {
        format: input.data.format,
        fields: input.data.fields,
        ...(input.data.filterJson !== undefined ? { filterJson: input.data.filterJson } : {}),
        exportId: exportRecord.id,
      },
    },
  });

  await prisma.export.update({ where: { id: exportRecord.id }, data: { jobId: job.id } });
  try {
    await enqueue(queues.export, "run-export", { jobId: job.id });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json({ export: exportRecord, jobId: job.id }, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
