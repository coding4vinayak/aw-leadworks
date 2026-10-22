import type { JobCounters } from "./job-report";
import { counter, progressValue } from "./job-report";

/** The status a worker writes when it takes a row over — never the mark it must not. */
const BEGIN = "RUNNING";

/**
 * What a worker does with a mark it did not make.
 *
 * Measured before this file existed: `?action=cancel` has been in the README's API
 * list since the first commit, `POST /api/jobs/{id}?action=cancel` wrote the mark and
 * `completedAt` and answered `{ ok: true }`, and nothing in `src/` read the mark back —
 * not one of the four workers that can finish on this instance. A cancelled row was a
 * suggestion. The census said 475 `Job` rows, 466 COMPLETED, and **0 CANCELLED**: not one
 * operator had ever been able to make the door work, so no one had used it. The reading
 * `lib/job-report.ts` shipped last round already had to say the quiet part — *nothing in
 * this application stops a worker that is running* — because that was the truth about the
 * code, and this round is the round that makes it false.
 *
 * So this file owns two things: which stored status is a mark a running worker must obey,
 * and the row write that obeys it. The *reading* of a marked row — what its counters say
 * and what the door should hand back about them — stays in `job-report.ts`, one owner for
 * the words.
 *
 * It holds no query. The worker asks the database; this file decides what the answer means
 * and what gets written because of it.
 */

/**
 * Where the mark is read: at the boundary before a row, never inside one.
 *
 * A row already in flight finishes, because a worker that abandoned a half-written lead
 * would leave the crowd in a state no record describes. That is the whole of what a stop
 * cannot promise, and it is why the boundary is between rows rather than at an
 * `await`.
 */
export const MARK = "CANCELLED";

/**
 * The mark, read off the row.
 *
 * A row that is gone is not a mark: a deleted job takes its records with it, and a worker
 * still holding its id must not treat the absence as permission to stop, because it would
 * then write a terminal status to a row that is not there.
 */
export function isMarked(row: { status: string } | null | undefined): boolean {
  return row !== null && row !== undefined && row.status === MARK;
}

/**
 * The write that says "this worker has it", for a `updateMany` whose WHERE carries
 * `status: { not: MARK }` rather than an unconditional `update`.
 *
 * The row a worker reads at its top is a snapshot, and a cancel that lands between that
 * read and this write would otherwise be answered with a `RUNNING` stamped by the very
 * worker that was told to stop — the mark gone, the job running to a COMPLETED no
 * operator asked for. One statement with the mark in its WHERE takes the database's
 * answer instead of the worker's memory of it: `count: 0` means the row says the mark, or
 * is gone, and either way there is nothing to run and nothing to write.
 *
 * A mark read before the worker begins is the cheapest stop there is — no row visited,
 * nothing half-written — which is why this is the first write a worker makes.
 */
export function startWrite(at: Date): { status: string; startedAt: Date } {
  return { status: BEGIN, startedAt: at };
}

/**
 * The terminal write of a worker that obeyed the mark.
 *
 * The status is the door's own — a worker that stops does not overwrite the mark with a
 * word of its own. Everything else is written the way a completed row writes it: the
 * denominator the worker walked, the counters it holds, and the percentage between them.
 */
export function stoppedWrite(
  counters: JobCounters,
  at: Date,
): {
  status: string;
  completedAt: Date;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  progress: number;
} {
  const processed = counter(counters.processed);
  const failed = counter(counters.failed);
  return {
    status: MARK,
    completedAt: at,
    totalItems: counter(counters.total),
    processedItems: processed,
    failedItems: failed,
    progress: progressValue({ total: counters.total, processed, failed }),
  };
}
