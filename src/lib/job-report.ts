import type { Prisma } from "@/generated/prisma/client";
import { asInputJson } from "./json";
import { ENRICH_WRITABLE, holds } from "./enrich-plan";

/**
 * What a job row is allowed to claim about the work it did.
 *
 * Measured on this instance before any of this existed: 475 `Job` rows, 466 of
 * them COMPLETED, every one of them reporting `progress: 100` — because 100 was
 * typed at the finish line in all five workers rather than computed from the
 * counters a few lines above it. 386 of those rows also said `totalItems: 0`
 * while saying `processedItems: 16`: the workers held the crowd size in a local
 * and never wrote it down, so the percentage was taken over a denominator the row
 * denies having. Five more said COMPLETED with `failedItems > 0` — true, and
 * unstated, because `Job.status` has no value between COMPLETED and FAILED. And
 * `JobResult`, the table `GET /api/jobs/{id}` includes as `results`, held zero
 * rows across all 475 jobs, because nothing in `src/` has ever written one.
 *
 * So this file owns four things and nothing else: the arithmetic behind a
 * percentage, the words for the case where arithmetic has nothing to work on, the
 * reading of a visit that reached a row and wrote nothing to it, and the shape of a
 * per-item record a worker may write down while it still holds the item.
 */

/** The counters a worker holds at the moment it finishes. */
export interface JobCounters {
  /** Rows the job knew it had. 0 means it never stamped a denominator. */
  total: number;
  /** Rows it visited and came back from. */
  processed: number;
  /** Rows it could not finish. Disjoint from `processed`. */
  failed: number;
}

/**
 * A percentage, or the reason there is no percentage to take.
 *
 * `percent` is 0 in the unmeasured branch because the column this eventually
 * reaches is a non-null `Int` and 0 is the value that claims least. Read it with
 * `measured` or it says "did nothing" about a job that finished everything it was
 * given, which was nothing.
 */
export type Progress =
  | { measured: true; percent: number; reason: null }
  | { measured: false; percent: 0; reason: string };

export const NO_DENOMINATOR =
  "not measured: this job stamped no denominator, so there is no share of a whole to report";

/** One counter, coerced to what a row can actually hold. */
function counter(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Rows accounted for: visited, or tried and failed. */
export function handled(counters: JobCounters): number {
  return counter(counters.processed) + counter(counters.failed);
}

export function progressOf(counters: JobCounters): Progress {
  const total = counter(counters.total);
  if (total <= 0) return { measured: false, percent: 0, reason: NO_DENOMINATOR };
  const done = Math.min(handled(counters), total);
  return { measured: true, percent: Math.round((done / total) * 100), reason: null };
}

/** The integer a worker writes into `Job.progress`. */
export function progressValue(counters: JobCounters): number {
  return progressOf(counters).percent;
}

/**
 * Where a row's own numbers cannot all be true at once, what is wrong with them.
 *
 * This is a reading, not a repair: the 386 historical rows that say "out of 0, I
 * did 16" stay exactly as they are, and the fix is that no *new* row can be
 * written that way.
 */
export function countersProblem(counters: JobCounters): string | null {
  const total = counter(counters.total);
  const done = handled(counters);
  if (done > total) {
    return `${done} row(s) accounted for against a denominator of ${total} — the job reported work on rows it never counted into its total`;
  }
  if (total > 0 && done === 0) {
    return `a denominator of ${total} and nothing accounted for — this job finished without saying it visited any row`;
  }
  return null;
}

/** The set `JobResult.status` is documented as holding. */
export const RESULT_STATUSES = ["SUCCESS", "FAILED", "SKIPPED"] as const;
export type ItemStatus = (typeof RESULT_STATUSES)[number];

/** What one worker decided about one row, before any of it is written down. */
export interface ItemOutcome {
  /** `null` when the row no longer exists to point at — a deleted lead. */
  leadId: string | null;
  status: ItemStatus;
  data?: Record<string, unknown> | null;
  error?: string | null;
}

/**
 * A `JobResult` write from an outcome, with the two things a caller must not be
 * allowed to leave out.
 *
 * A FAILED row with no message would assert that something went wrong and refuse
 * to say what, so the absence becomes the text — the failure is the worker's, not
 * the item's, and it reads that way. A SKIPPED row with no reason would be
 * indistinguishable from a row nothing looked at, so the reason rides in `data`.
 */
export function jobResultRow(jobId: string, outcome: ItemOutcome): {
  jobId: string;
  leadId: string | null;
  status: ItemStatus;
  data: Prisma.InputJsonValue;
  error: string | null;
} {
  const status: ItemStatus = RESULT_STATUSES.includes(outcome.status) ? outcome.status : "FAILED";
  const detail: Record<string, unknown> = { ...(outcome.data ?? {}) };
  let error = typeof outcome.error === "string" && outcome.error.trim() !== "" ? outcome.error.trim() : null;

  if (status === "FAILED" && error === null) {
    error = "reported as a failure with no reason captured";
  }
  if (status === "SKIPPED" && typeof detail.reason !== "string") {
    detail.reason = "skipped, with no reason recorded by the worker that skipped it";
  }
  return { jobId, leadId: outcome.leadId, status, data: asInputJson(detail), error };
}

/**
 * What one enrichment visit decided about one lead, in the four sets the worker
 * has when it finishes: what the providers named, what the rule's `fields` allowed
 * through, what the row actually changed, and the row itself.
 */
export interface EnrichVisit {
  /** The lead as the plan saw it, so "already held" is read from the same values. */
  lead: Record<string, unknown>;
  /** Every column a provider named, before this rule's `fields` narrowed the answer. */
  named: readonly string[];
  /** The named columns that survived the narrowing — the answer handed to the plan. */
  answered: readonly string[];
  /** The columns the row was changed by. */
  written: readonly string[];
  /** The rule's declared `fields`, which is what narrowed `named` to `answered`. */
  declaredFields: readonly string[];
}

/**
 * The per-item record of one enrichment visit, with the reason taken from the sets
 * rather than from a sentence the worker hoped was true.
 *
 * A visit that wrote nothing has three different causes and used to share one
 * string. `planEnrichmentWrite` gates a column three ways — a lead row has no column
 * for it, the row already holds a value, or the value is not a shape the column
 * takes — and the record now names whichever of them actually applied, beside the
 * sets it was derived from. An empty `answered` is a fourth case: the providers
 * replied, and there was no column in the reply.
 */
export function enrichmentVisit(leadId: string, visit: EnrichVisit): ItemOutcome {
  const written = [...visit.written];
  if (written.length > 0) {
    return { leadId, status: "SUCCESS", data: { writtenColumns: written, answeredColumns: [...visit.answered] } };
  }

  const named = [...visit.named];
  const answered = [...visit.answered];
  if (named.length === 0) {
    return {
      leadId,
      status: "SKIPPED",
      data: { reason: "the providers replied, and their answer named no column at all" },
    };
  }
  if (answered.length === 0) {
    return {
      leadId,
      status: "SKIPPED",
      data: {
        reason: `the providers named ${words(named)} and none of it is a column this rule declared`,
        answeredColumns: named,
        declaredFields: [...visit.declaredFields],
      },
    };
  }

  const writable = (column: string) => (ENRICH_WRITABLE as readonly string[]).includes(column);
  const noColumn = answered.filter((column) => !writable(column));
  const held = answered.filter((column) => writable(column) && holds(visit.lead[column]));
  const refused = answered.filter((column) => !noColumn.includes(column) && !held.includes(column));
  const parts: string[] = [];
  if (noColumn.length > 0) parts.push(`${words(noColumn)} is not a column a lead row has`);
  if (held.length > 0) parts.push(`the row already held ${words(held)}`);
  if (refused.length > 0) parts.push(`${words(refused)} came back in a shape its column does not accept`);

  return {
    leadId,
    status: "SKIPPED",
    data: {
      reason: parts.join("; "),
      answeredColumns: answered,
      notAColumn: noColumn,
      alreadyHeld: held,
      refusedForShape: refused,
    },
  };
}

function words(list: readonly string[]): string {
  return list.map((column) => `\`${column}\``).join(", ");
}

/** `Job.status` cannot say "done, and some of it failed", so the reading does. */
export interface Verdict {
  verdict: string;
  note: string | null;
}

export function verdictFor(status: string, counters: JobCounters): Verdict {
  const failed = counter(counters.failed);
  if (status === "COMPLETED") {
    const progress = progressOf(counters);
    if (!progress.measured) {
      return {
        verdict: "COMPLETED",
        note: "finished; how far through it was is not measurable from this row",
      };
    }
    if (failed > 0) {
      return {
        verdict: "COMPLETED",
        note: `partial: ${failed} of ${counter(counters.total)} row(s) could not be finished. Derived here — \`Job.status\` has no value for it`,
      };
    }
    return { verdict: "COMPLETED", note: null };
  }
  if (status === "FAILED") {
    return {
      verdict: "FAILED",
      note: failed > 0 ? `${failed} row(s) had already been accounted for when the job stopped` : null,
    };
  }
  if (status === "CANCELLED") {
    return {
      verdict: "CANCELLED",
      note:
        counter(counters.processed) > 0
          ? `${counter(counters.processed)} row(s) were already written before the cancel — nothing in this application stops a worker that is running`
          : null,
    };
  }
  return { verdict: status, note: null };
}

/**
 * The reading `GET /api/jobs/{id}` hands back beside the raw row.
 *
 * `results` on the row itself is `take: 50` of the newest records, so a caller
 * cannot tell 50 of 50 from 50 of 4,000 without `recorded`. It is counted rather
 * than inferred from the array's length.
 */
export interface JobReport {
  measured: boolean;
  percent: number;
  reason: string | null;
  verdict: string;
  verdictNote: string | null;
  problem: string | null;
  results: { recorded: number; returned: number; truncated: boolean };
}

export function jobReport(
  row: { status: string; progress: number; totalItems: number; processedItems: number; failedItems: number },
  recorded: number,
  returned: number,
): JobReport {
  const counters: JobCounters = {
    total: row.totalItems,
    processed: row.processedItems,
    failed: row.failedItems,
  };
  const progress = progressOf(counters);
  const verdict = verdictFor(row.status, counters);
  return {
    measured: progress.measured,
    percent: progress.percent,
    reason: progress.reason,
    verdict: verdict.verdict,
    verdictNote: verdict.note,
    problem: countersProblem(counters),
    results: { recorded, returned, truncated: recorded > returned },
  };
}
