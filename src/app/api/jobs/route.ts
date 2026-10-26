import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { readJson, validateBody } from "@/lib/validate";
import { JOB_CREATE } from "@/lib/fields";
import { idFilterParam, unknownIdError } from "@/lib/ids";
import { enqueueJob, QueueUnavailableError } from "@/lib/queue";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const type = searchParams.get("type");
  const status = searchParams.get("status");
  const { page, limit } = pageParams(searchParams, 20);

  // Resolved the way `POST /api/jobs` resolves it: an unknown `sourceId` there is a 422
  // naming the id, and here it was a page that looked like a source with no jobs.
  const source = await idFilterParam(searchParams, "sourceId", (id) =>
    prisma.source.count({ where: { workspaceId, id } }).then((n) => n > 0));
  if (source.error) return source.error;

  const where: any = { workspaceId };
  if (source.id) where.sourceId = source.id;
  if (type) where.type = type;
  if (status) where.status = status;

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      include: { source: { select: { id: true, name: true } }, _count: { select: { results: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.job.count({ where }),
  ]);

  return NextResponse.json({ jobs, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, JOB_CREATE);
  if (!input.ok) return input.error;

  // A foreign key is a fact about another row, and Prisma only says "constraint
  // violated": measured, `sourceId: "nope"` left as a 500 (P2003) with no field
  // named. Scoped to this workspace, so another tenant's source reads as one
  // that does not exist.
  if (input.data.sourceId) {
    const found = await prisma.source.findMany({
      where: { workspaceId, id: input.data.sourceId },
      select: { id: true },
    });
    if (!found.length) return unknownIdError("sourceId", input.data.sourceId);
  }

  const job = await prisma.job.create({
    data: { workspaceId, ...input.data, status: "PENDING" },
  });

  // Every other writer of a Job row in this app enqueues immediately after the
  // insert (`scheduler.ts`, `scraper.ts`, `exporter.ts`, `enrichment.ts`,
  // `sources/[id]`, `leads/[id]`) and nothing sweeps a PENDING row, so this call
  // is what makes the 201 mean work started. 503 rather than 201 when Redis is
  // down: the row is saved, and the same request can be retried.
  try {
    await enqueueJob(input.data.type, job.id);
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  return NextResponse.json(job, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
