import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { resolveAiActor, withAiAuth } from "@/lib/ai-actor";
import { isLlmConfigured } from "@/lib/llm";
import { explainLeadScore } from "@/lib/ai-score";
import { computeLeadScore, readScoreLedger } from "@/lib/lead-score";
import { oneIdParam } from "@/lib/ids";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/explain-lead?id=…&model=…
 *
 * Explains the score LeadWorks already computed. Read-only: the response
 * carries the deterministic score alongside the model's reasoning so a rep can
 * always see the number that actually drives the queue.
 *
 * The arithmetic comes back with it. `lib/lead-score.ts` stamps every write with
 * the terms it used, and this route also computes the row's score again from what
 * the row holds now: the two are the same for any lead this build wrote, and where
 * they differ — a row this build has never written, whose score is still the column
 * default — `stale: true` says so rather than presenting one number as the other.
 */
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  // The name is read the way this app reads every name in a query string — trimmed, and
  // refused when the same key is spelled twice with two different answers. Measured on the
  // build before this line (`15e100e`, `:3431`): `?id=%20ld_r72_ana%20` answered
  // `404 lead not found` for a lead tenant A holds, while `GET /api/leads?listId=%20…%20`
  // answered that same padding with the rows it names; and `?id=<ana>&id=<bo>` explained
  // `ana` in bytes identical to the control and dropped `bo` without a word.
  const asked = oneIdParam(searchParams, "id");
  if (asked.error) return asked.error;
  const model = searchParams.get("model") ?? undefined;

  if (asked.value === null) return NextResponse.json({ error: "id required" }, { status: 400 });

  const actor = await resolveAiActor(request, {
    // A query-string claim can only ever be `string | null`, so this app is not
    // the one with a type problem — but the rule is one rule now, and the check
    // lives in the vendored module rather than in this app's `authedWorkspaceId`.
    claimedWorkspaceId: searchParams.get("workspaceId"),
    keyWorkspaceId: () => authedWorkspaceId(request),
  });

  // Scoped in the query: another tenant's lead is not found, not fetched-then-refused.
  // The refusal stays a 404 rather than the 422 an unresolvable *filter* earns, because
  // this door reads the row it was named, which is what `GET /api/leads/{id}` does too.
  const lead = await prisma.lead.findFirst({
    where: { id: asked.value, workspaceId: actor.workspaceId },
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

  // The arithmetic, from the row. `stamped` is what the last writer left on the
  // lead; when the row predates the module the same function answers for it now, so
  // the buyer is never handed a number with no terms beside it.
  const live = computeLeadScore(lead);
  const ledger = readScoreLedger(lead.scoreBreakdown) ?? live.breakdown;
  const arithmetic = {
    score: lead.score,
    scoredAt: lead.scoredAt,
    stale: lead.score !== live.score,
    breakdown: ledger,
  };

  if (!isLlmConfigured()) {
    return NextResponse.json({
      explained: false,
      configured: false,
      ...arithmetic,
      reason: "No LLM_API_KEY set — this is LeadWorks' own arithmetic, every term in it, and the score it produced.",
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
        ...arithmetic,
        reason: "The model was unreachable or returned nothing usable. The score stands.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    explained: true,
    // The number that actually drives the queue, not the model's opinion of it.
    ...arithmetic,
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
