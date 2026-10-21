import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asInputJson } from "@/lib/json";
import { readJson, validateBody } from "@/lib/validate";
import { RULE_PATCH } from "@/lib/fields";
import { conditionsProblem, describeConditions, normalizeConditions, readStoredConditions } from "@/lib/rule-conditions";
import { normalizeProviders, providersProblem } from "@/lib/enrichment-providers";
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

  const declared = input.data.conditions;
  if (declared !== undefined) {
    const problem = conditionsProblem(declared);
    if (problem !== null) return NextResponse.json({ error: problem }, { status: 400 });
  }

  // A rule edited to a provider nothing implements is the same silence as one
  // created that way, so it is refused at the same door.
  const named = input.data.providers;
  if (named !== undefined) {
    const providerProblem = providersProblem(named);
    if (providerProblem !== null) return NextResponse.json({ error: providerProblem }, { status: 400 });
  }

  const rule = await prisma.enrichmentRule.update({
    where: { id },
    data: {
      ...(declared === undefined ? input.data : { ...input.data, conditions: asInputJson(normalizeConditions(declared)) }),
      ...(named === undefined ? {} : { providers: asInputJson(normalizeProviders(named)) }),
    },
  });
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

    // The rule's own declaration, read the way the scheduler reads it. A blob that
    // cannot be read is refused here rather than queued: this route has a caller to
    // tell, and "0 leads" is not an answer they could act on.
    const stored = readStoredConditions(rule.conditions);
    if (stored.problem !== null) {
      return NextResponse.json({ error: `rule cannot run: ${stored.problem}` }, { status: 400 });
    }

    // No lead query here, where the scheduler's copy of this has one: which
    // leads get enriched is the worker's decision, and the list was loaded,
    // counted and thrown away. What the worker needs from this route is the
    // declaration, so it applies the same conditions the rule states instead of
    // the status set it used to carry in its source.
    // `actions` — what the rule says to enrich — is still not read here: the worker
    // takes its field list from `config.fields`, which this route has always
    // sent empty, and the provider stubs in `lib/enrichment.ts` ignore that
    // list either way.
    const job = await prisma.job.create({
      data: {
        workspaceId: rule.workspaceId,
        type: "ENRICH",
        status: "PENDING",
        config: { providers: asInputJson(rule.providers), fields: [], confidenceThreshold: 0.5, conditions: asInputJson(stored.conditions), ruleId: rule.id },
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

    return NextResponse.json({ jobId: job.id, appliesTo: describeConditions(stored.conditions) });
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
