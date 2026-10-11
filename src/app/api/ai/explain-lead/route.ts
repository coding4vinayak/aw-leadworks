import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { resolveAiActor, withAiAuth } from "@/lib/ai-actor";
import { isLlmConfigured } from "@/lib/llm";
import { explainLeadScore } from "@/lib/ai-score";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/explain-lead?id=…&model=…
 *
 * Explains the score LeadWorks already computed. Read-only: the response
 * carries the deterministic score alongside the model's reasoning so a rep can
 * always see the number that actually drives the queue.
 */
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const model = searchParams.get("model") ?? undefined;

  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const actor = await resolveAiActor(request, {
    // A query-string claim can only ever be `string | null`, so this app is not
    // the one with a type problem — but the rule is one rule now, and the check
    // lives in the vendored module rather than in this app's `authedWorkspaceId`.
    claimedWorkspaceId: searchParams.get("workspaceId"),
    keyWorkspaceId: () => authedWorkspaceId(request),
  });

  // Scoped in the query: another tenant's lead is not found, not fetched-then-refused.
  const lead = await prisma.lead.findFirst({
    where: { id, workspaceId: actor.workspaceId },
    include: {
      source: { select: { name: true, type: true } },
      enrichmentLogs: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 });

  // Reconstruct the signals the score was computed from, so the model explains
  // the real inputs rather than whatever happens to be on the row today.
  const enrichment: Record<string, unknown> = {
    email: lead.email,
    phone: lead.phone,
    linkedinUrl: lead.linkedinUrl,
    title: lead.title,
    company: lead.company,
    department: lead.department,
    seniority: lead.seniority,
    location: lead.location,
    country: lead.country,
  };
  for (const log of lead.enrichmentLogs) {
    if (log.afterData && typeof log.afterData === "object") {
      Object.assign(enrichment, log.afterData as Record<string, unknown>);
    }
  }

  if (!isLlmConfigured()) {
    return NextResponse.json({
      explained: false,
      configured: false,
      score: lead.score,
      reason: "No LLM_API_KEY set — the deterministic score is unaffected and still returned.",
    });
  }

  const explanation = await explainLeadScore({
    score: lead.score,
    lead: {
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.company,
      title: lead.title,
      email: lead.email,
      phone: lead.phone,
      linkedinUrl: lead.linkedinUrl,
    },
    enrichment,
    source: lead.source?.name ?? null,
    model,
  });

  if (!explanation) {
    return NextResponse.json(
      {
        explained: false,
        score: lead.score,
        reason: "The model was unreachable or returned nothing usable. The score stands.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    explained: true,
    // The number that actually drives the queue, not the model's opinion of it.
    score: lead.score,
    explanation: {
      summary: explanation.summary,
      reasons: explanation.reasons,
      gaps: explanation.gaps,
      confidence: explanation.confidence,
    },
    usage: explanation.usage,
    model: explanation.model,
    note: "Explanation only — the score was not modified.",
  });
}

export const GET = withAuth(withAiAuth(GET_impl));
