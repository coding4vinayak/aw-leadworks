/**
 * `Lead.score` has one owner: this module.
 *
 * Before this round nobody computed it. The schema comment says "Lead score
 * 0-100", the dashboard sorts the buyer's shortlist by it, `GET /api/leads`
 * answers `orderBy: { score: "desc" }` and `ai-score.ts` documents that the model
 * explains "a score that already exists". The only automatic writer was the
 * VALIDATE worker's `score: Math.max(0, lead.score - failedChecks.length * 10)` —
 * a subtraction from a number nothing had ever added. Leads arrived from intake
 * and from the CSV importer at 0; the demo's three best-imported contacts sat at
 * `score=0` with an email, a company, a title, a location, a country and an
 * industry, because the importer never looked; and running the validator twice
 * knocked the same three failed checks off twice, so a score decayed every time
 * somebody asked whether the data was good. `POST /api/ai/explain-lead` returned
 * "the deterministic score is unaffected and still returned" about a score that
 * was not deterministic, or a score at all.
 *
 * So the ownership is declared:
 *
 * - **The row's own signals, and nothing else.** `SCORE_TERMS` is the whole
 *   arithmetic: one entry per `Lead` column that means something to a buyer, with
 *   the points it is worth. The terms sum to exactly 100, so "0-100" is a property
 *   of the table rather than a clamp that hides a bigger number, and the only
 *   subtraction is the validation penalty below. No provider return value, no
 *   model opinion, no threshold, no time-decay.
 * - **A person's number is stored as a person's number.** A `PATCH` that sets
 *   `score` writes `scoreOverride`; the computed score follows it, and the
 *   breakdown keeps showing what the row itself earned beside it. `score: null`
 *   gives the override back. Nothing else in the product writes that column, and
 *   enrichment is not allowed to fill it (`ENRICH_WRITABLE`), so a third party's
 *   guess cannot impersonate a decision someone made.
 * - **A check that failed is a rule, not a side effect.** `VALIDATION_PENALTY_PER_FAILED_CHECK`
 *   is subtracted from the base by the same function that added the terms, so the
 *   score is a pure function of the row and running the validator again over the
 *   same data is idempotent. `validationResults` is overwritten each run, which is
 *   the only reason it is safe to read it as an input.
 * - **The work travels with the number.** Every computation returns the terms it
 *   used, the columns it did not earn and the checks that failed, and the writers
 *   store it. A buyer asking "why 61?" is answered from the row, with or without
 *   an LLM configured.
 *
 * What the number means, stated once: **how much this workspace knows about this
 * person and their company** — reachability, a named human, firmographics, intent,
 * provenance. It is not seniority's rank in disguise (`C_LEVEL` and `IC` earn the
 * same 6 for being known, and `UNKNOWN` earns nothing), it is not outcome
 * (`CONVERTED` earns nothing; the sales process is not a signal about the data) and
 * it is not a fit score for any particular campaign. `GET /api/leads?minScore=` and
 * the top-leads table rank by completeness of knowledge, and the README says so.
 */

import type { Prisma } from "@/generated/prisma/client";
import { LEAD_SENIORITIES } from "./enums";

/** The columns the arithmetic reads. Nothing else can move a score. */
export interface ScoreableLead {
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
  seniority?: string | null;
  department?: string | null;
  location?: string | null;
  country?: string | null;
  industry?: string | null;
  companySize?: string | null;
  revenue?: string | null;
  technologies?: unknown;
  intentSignals?: unknown;
  sourceId?: string | null;
  validationResults?: unknown;
  scoreOverride?: number | null;
}

export type ScoreGroup = "contact" | "identity" | "firm" | "intent" | "provenance";

export interface ScoreTerm {
  /** The `Lead` column this term is worth points for. */
  column: keyof ScoreableLead & string;
  points: number;
  group: ScoreGroup;
  /** The sentence a buyer reads beside the number. */
  why: string;
}

/**
 * A word a column holds. Blank, absent, or whitespace that a text input kept is
 * not knowledge, so it earns nothing — the same reading `enrich-plan.ts`'s `holds`
 * gives when it decides whether a gap exists.
 */
function known(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** A list of words in a Json column, which is what the column's comment says. */
function wordList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "");
}

/**
 * `seniority` is known when it names a rung. `UNKNOWN` is in `LEAD_SENIORITIES`
 * because a person chose to file it there; it is the absence of the signal, so it
 * earns the absence of points.
 */
function rungKnown(value: string | null | undefined): boolean {
  return (
    typeof value === "string" &&
    (LEAD_SENIORITIES as readonly string[]).includes(value) &&
    value !== "UNKNOWN"
  );
}

/**
 * The whole arithmetic. One entry per column, and the points sum to exactly 100 —
 * contact 30, identity 16, firm 36, intent 14, provenance 4. `tests/unit/lead-score.test.ts`
 * reads this table against `prisma/schema.prisma` and fails if a term names a
 * column `Lead` does not have, if the total drifts off 100, or if a column stopped
 * appearing here without the test being told about it.
 */
export const SCORE_TERMS: readonly ScoreTerm[] = [
  { column: "email", points: 15, group: "contact", why: "an address to write to" },
  { column: "phone", points: 8, group: "contact", why: "a number to call" },
  { column: "linkedinUrl", points: 7, group: "contact", why: "a profile to check the person against" },

  { column: "firstName", points: 5, group: "identity", why: "a first name to open with" },
  { column: "lastName", points: 5, group: "identity", why: "a last name to address" },
  { column: "title", points: 6, group: "identity", why: "a stated role, which `derive` reads for seniority" },

  { column: "company", points: 10, group: "firm", why: "the company to look up" },
  { column: "seniority", points: 6, group: "firm", why: "where they sit, named rather than guessed" },
  { column: "department", points: 3, group: "firm", why: "which part of the company they own" },
  { column: "location", points: 3, group: "firm", why: "a place, for timezone and territory" },
  { column: "country", points: 3, group: "firm", why: "a country, for compliance and language" },
  { column: "industry", points: 4, group: "firm", why: "the industry the pitch is written for" },
  { column: "companySize", points: 4, group: "firm", why: "how many people the answer has to cover" },
  { column: "revenue", points: 3, group: "firm", why: "how much budget is plausible" },

  { column: "technologies", points: 6, group: "intent", why: "a detected stack the product fits or replaces" },
  { column: "intentSignals", points: 8, group: "intent", why: "a buying signal someone recorded" },

  { column: "sourceId", points: 4, group: "provenance", why: "the source this row came from is named, so it can be re-checked" },
] as const;

/** Points off per check the validator recorded as failed. */
export const VALIDATION_PENALTY_PER_FAILED_CHECK = 10;

/** The columns a term is worth points for, in table order. */
export const SCORE_COLUMNS: readonly string[] = SCORE_TERMS.map((term) => term.column);

export interface EarnedTerm extends ScoreTerm {
  earned: true;
}

export interface FailedCheck {
  check: string;
  message: string | null;
}

/**
 * What a score is made of, stored with the row so the answer to "why this number"
 * survives whatever the row looks like when the question is asked.
 */
export interface ScoreBreakdown {
  /** `signals` when the arithmetic decided, `override` when a person did. */
  basis: "signals" | "override";
  /** The computed total from the terms, before any penalty. */
  computed: number;
  /** The number a person set, or `null` when nobody did. */
  override: number | null;
  /** The base the score starts from: the override when there is one, else `computed`. */
  base: number;
  /** The terms the row earned, with their points and their sentences. */
  earned: EarnedTerm[];
  /** The columns it did not earn — the shortest answer to "what would raise this". */
  missing: string[];
  /** `missing` grouped, so a reader sees which part of the row is thin. */
  gaps: ScoreGroup[];
  /** Zero or negative: the recorded failed checks, priced by the rule above. */
  penalty: number;
  failedChecks: FailedCheck[];
  /** `base` plus `penalty`, floored at 0. */
  score: number;
}

export interface ComputedScore {
  score: number;
  breakdown: ScoreBreakdown;
}

/** The failed checks among the results the validator stored, if any are there. */
function recordedFailures(value: unknown): FailedCheck[] {
  if (!Array.isArray(value)) return [];
  const failures: FailedCheck[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const result = entry as Record<string, unknown>;
    if (result.valid === false) {
      const check = typeof result.check === "string" ? result.check : "";
      if (!check) continue;
      failures.push({ check, message: typeof result.message === "string" ? result.message : null });
    }
  }
  return failures;
}

/**
 * The score this row's signals say, and the arithmetic that got there.
 *
 * Pure: the same row in, the same score out, which is the whole reason the
 * validator's penalty is an input here rather than a subtraction the worker makes
 * from whatever number the column happened to hold.
 */
export function computeLeadScore(lead: ScoreableLead): ComputedScore {
  const earned: EarnedTerm[] = [];
  const missing: string[] = [];
  const gaps: ScoreGroup[] = [];
  let computed = 0;

  for (const term of SCORE_TERMS) {
    const value = lead[term.column];
    const isKnown = term.column === "seniority" ? rungKnown(value as string | null)
      : term.column === "technologies" || term.column === "intentSignals" ? wordList(value)
      : known(value as string | null);
    if (isKnown) {
      earned.push({ ...term, earned: true });
      computed += term.points;
    } else {
      missing.push(term.column);
      if (!gaps.includes(term.group)) gaps.push(term.group);
    }
  }

  const override = typeof lead.scoreOverride === "number" ? lead.scoreOverride : null;
  const base = override ?? computed;
  const failedChecks = recordedFailures(lead.validationResults);
  // `-0` is a number a Json column turns into `0`, so a ledger that had not been
  // stored would not read back as itself.
  const penalty = failedChecks.length > 0 ? -failedChecks.length * VALIDATION_PENALTY_PER_FAILED_CHECK : 0;
  const score = Math.max(0, base + penalty);

  return {
    score,
    breakdown: {
      basis: override === null ? "signals" : "override",
      computed,
      override,
      base,
      earned,
      missing,
      gaps,
      penalty,
      failedChecks,
      score,
    },
  };
}

/**
 * The three columns a writer touches when it changes a lead's signals. Spread into
 * `data` at create and at update — this is the only shape `Lead.score` may be
 * written in, and the unit tests read the source for it. The `ScoreBreakdown` is
 * cast to Prisma's Json input rather than declared as one: the ledger is this
 * module's shape, and a column comment is not where a shape gets decided.
 */
export type ScoredWrite = {
  score: number;
  scoreBreakdown: Prisma.InputJsonValue;
  scoredAt: Date;
};

export function scoredWriteData(lead: ScoreableLead, now: Date = new Date()): ScoredWrite {
  const { score, breakdown } = computeLeadScore(lead);
  return {
    score,
    scoreBreakdown: breakdown as unknown as Prisma.InputJsonValue,
    scoredAt: now,
  };
}

/**
 * The stored ledger read back. `Lead.scoreBreakdown` is a Json column, so what a
 * reader holds is `Prisma.JsonValue` and not this module's shape: narrowed here,
 * defensively, because the readers are a customer-facing table and a 500 from a
 * row whose Json predates this module would be the second way a score lied. `null`
 * means "no stamped arithmetic" — the reader falls back to computing it live,
 * which is exactly what `computeLeadScore` is for.
 */
export function readScoreLedger(value: unknown): ScoreBreakdown | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const ledger = value as Record<string, unknown>;
  if (typeof ledger.score !== "number" || typeof ledger.computed !== "number") return null;
  if (!Array.isArray(ledger.earned) || !Array.isArray(ledger.missing)) return null;
  const earned: EarnedTerm[] = [];
  for (const entry of ledger.earned) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const term = entry as Record<string, unknown>;
    if (typeof term.column !== "string" || typeof term.points !== "number" || typeof term.why !== "string") continue;
    if (typeof term.group !== "string") continue;
    // A term for a column this table does not read is not the arithmetic this
    // module owns, so it is dropped rather than displayed.
    if (!SCORE_COLUMNS.includes(term.column)) continue;
    earned.push({ column: term.column as ScoreTerm["column"], points: term.points, why: term.why, group: term.group as ScoreGroup, earned: true });
  }
  return {
    basis: ledger.basis === "override" ? "override" : "signals",
    computed: ledger.computed,
    override: typeof ledger.override === "number" ? ledger.override : null,
    base: typeof ledger.base === "number" ? ledger.base : ledger.computed,
    earned,
    missing: ledger.missing.filter((item): item is string => typeof item === "string"),
    gaps: (Array.isArray(ledger.gaps) ? ledger.gaps : []).filter((item): item is ScoreGroup =>
      ["contact", "identity", "firm", "intent", "provenance"].includes(item as string)),
    penalty: typeof ledger.penalty === "number" ? ledger.penalty : 0,
    failedChecks: (Array.isArray(ledger.failedChecks) ? ledger.failedChecks : [])
      .map((entry): FailedCheck | null => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
        const check = entry as Record<string, unknown>;
        if (typeof check.check !== "string") return null;
        return { check: check.check, message: typeof check.message === "string" ? check.message : null };
      })
      .filter((entry): entry is FailedCheck => entry !== null),
    score: ledger.score,
  };
}

/**
 * The row a write leaves behind, which is the row the score has to be computed
 * from. `undefined` is skipped rather than treated as a value because Prisma skips
 * it too: a writer that passes `firstName: undefined` in its `data` does not clear
 * the column, so a score computed as though it had would disagree with the row it
 * just wrote. `null` is kept — it is what a real clear looks like here.
 */
export function rowAfterWrite(row: Record<string, unknown>, changes: Record<string, unknown>): ScoreableLead {
  const merged: Record<string, unknown> = { ...row };
  for (const [column, value] of Object.entries(changes)) {
    if (value !== undefined) merged[column] = value;
  }
  return merged as unknown as ScoreableLead;
}
