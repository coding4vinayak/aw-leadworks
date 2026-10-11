import { completeJson, isLlmConfigured, type LlmUsage } from "./llm";

/**
 * AI explanation for a lead score that already exists.
 *
 * The deliberate choice: the model does **not** produce the score. LeadWorks
 * computes a deterministic 0–100 from enrichment signals, and that number is
 * what sales work from. The model's job is to say *why* in words a rep can act
 * on, and to flag what it is unsure about. A model that quietly rescore leads
 * would make the number unauditable — and an unauditable score is not a score.
 */

export interface ScoreExplanation {
  /** 1–2 sentences a rep can read in three seconds. */
  summary: string;
  /** The signals that drove the score, strongest first. */
  reasons: string[];
  /** What is missing that would raise the score. */
  gaps: string[];
  /** 0–1. How confident the model is in its own reasoning. */
  confidence: number;
  usage: LlmUsage;
  model: string;
}

const SYSTEM = `You explain lead scores to sales reps. You do not change scores.

Rules:
1. Use only the signals and facts provided. Never assume a budget, a timeline,
   a stack, or a pain the data does not show.
2. Every reason must trace to a signal in the input. No plausible-sounding inventions.
3. If the signals are thin, say so plainly and put it in \`gaps\`.
4. Plain text, no marketing language. A rep has ten of these to read a day.

Return JSON: { summary, reasons, gaps, confidence }.`;

export interface ExplainLeadInput {
  /** The deterministic score LeadWorks already computed. Context only. */
  score: number;
  lead: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    linkedinUrl?: string | null;
    notes?: string | null;
  };
  /** Enrichment fields that came back populated, and which. */
  enrichment: Record<string, unknown>;
  /** Source this lead came from, e.g. "linkedin-scraper". */
  source?: string | null;
  model?: string;
}

/**
 * Explain a score. Returns null when no model is configured or the call
 * fails — the score stands on its own, an absent explanation is not a defect.
 */
export async function explainLeadScore(input: ExplainLeadInput): Promise<ScoreExplanation | null> {
  if (!isLlmConfigured()) return null;

  const known = Object.entries(input.enrichment).filter(
    ([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
  );

  const lead = input.lead;
  const user = [
    `Deterministic score (already computed, do not change it): ${input.score}/100`,
    `Source: ${input.source ?? "unknown"}`,
    ``,
    `Lead:`,
    `  name: ${[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "(unknown)"}`,
    `  company: ${lead.company ?? "(unknown)"}`,
    `  title: ${lead.title ?? "(unknown)"}`,
    `  email: ${lead.email ?? "(none)"}`,
    `  phone: ${lead.phone ?? "(none)"}`,
    `  linkedin: ${lead.linkedinUrl ?? "(none)"}`,
    lead.notes ? `  notes: ${lead.notes}` : "",
    ``,
    `Enrichment signals present (${known.length}):`,
    known.length ? known.map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`).join("\n") : "  (none — this lead has no enrichment)",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await completeJson<{
    summary?: string;
    reasons?: string[];
    gaps?: string[];
    confidence?: number;
  }>(SYSTEM, user, {
    model: input.model,
    schemaHint: '{ "summary": string, "reasons": string[], "gaps": string[], "confidence": number }',
  });

  if (!result) return null;

  const summary = typeof result.data.summary === "string" ? result.data.summary.trim() : "";
  if (!summary) return null;

  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

  return {
    summary,
    reasons: asStrings(result.data.reasons),
    gaps: asStrings(result.data.gaps),
    confidence:
      typeof result.data.confidence === "number" ? Math.max(0, Math.min(1, result.data.confidence)) : 0.5,
    usage: result.usage,
    model: result.model,
  };
}
