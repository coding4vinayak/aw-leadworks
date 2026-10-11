import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { readJson, validateBody } from "@/lib/validate";
import { RULE_PATCH } from "@/lib/fields";
import { enqueueJob, QueueUnavailableError } from "@/lib/queue";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rule = await prisma.enrichmentRule.findUnique({
    where: { id },
    include: { logs: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, rule.workspaceId);
  return NextResponse.json(rule);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;

  const _owned = await prisma.enrichmentRule.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  const input = validateBody(raw.body, RULE_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  const rule = await prisma.enrichmentRule.update({ where: { id }, data: input.data });
  return NextResponse.json(rule);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "run") {
    const rule = await prisma.enrichmentRule.findUnique({ where: { id } });
    if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertOwns(request, rule.workspaceId);

    // No lead query here, where the scheduler's copy of this has one: which
    // leads get enriched is the worker's decision (`getLeadsToEnrich` reads the
    // same status set), and the list was loaded, counted and thrown away.
    // `actions` — what the rule says to enrich — is not read here: the worker
    // takes its field list from `config.fields`, which this route has always
    // sent empty, and the provider stubs in `lib/enrichment.ts` ignore that
    // list either way.
    const job = await prisma.job.create({
      data: {
        workspaceId: rule.workspaceId,
        type: "ENRICH",
        status: "PENDING",
        config: { providers: asInputJson(rule.providers), fields: [], confidenceThreshold: 0.5 },
      },
    });

    try {
      await enqueueJob("ENRICH", job.id);
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
  const _owned = await prisma.enrichmentRule.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.enrichmentRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
