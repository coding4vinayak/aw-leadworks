import type { Prisma } from "@/generated/prisma/client";
import { MARK } from "./job-stop";
import { asInputJson } from "./json";

/**
 * Which rows `POST /api/jobs/{id}?action=retry` may be taken from, and what the row
 * it creates carries.
 *
 * Measured on this instance before this file existed: the action had one condition —
 * `status !== "FAILED" && status !== "COMPLETED"` answered `400 "Can only retry failed
 * or completed jobs"`. So the mark last round made real was terminal in the one door
 * that would have undone it. An operator who stopped a job at row 4 of 200 could read
 * `CANCELLED`, could read the note saying 196 rows were never reached, and then found
 * the next sentence false: last round's own table claimed a stopped job "restarts over
 * the rows still standing", and the door refused the restart. The stop was honest and
 * irreversible, which is the worse combination — the word for what a stop leaves behind
 * is a job that can be finished.
 *
 * This file owns the two decisions the route used to make inline: whether the row's
 * status lets a resume be taken from it, and what the resumed row is allowed to claim
 * about itself at birth. The *obedience* of a stop stays in `job-stop.ts`, one owner for
 * that word; this one is about undoing it.
 *
 * It holds no query and no `NextResponse`. The route reads the row, asks here, and turns
 * the answer into a status code.
 */

/** The statuses the schema documents for a row a worker has put down. */
const TERMINAL = ["COMPLETED", "FAILED", MARK];

/** The statuses that mean a worker may still be holding this very row. */
const IN_FLIGHT = ["PENDING", "RUNNING"];

export type RetryAsk =
  | { ok: true }
  | { ok: false; http: 409; error: string }
  | { ok: false; http: 400; error: string };

/**
 * Ask whether a resume may be taken from a row in this status.
 *
 * A row still in flight is refused with 409 rather than a flat 400, because the reason is
 * the row's state and not the caller's request: `PENDING` means the queue has not handed
 * it to a worker yet and `RUNNING` means one is between rows right now, and a second row
 * carrying the same crowd would walk it beside the first. A terminal row is accepted, and
 * `CANCELLED` is terminal — that is the whole of what changed here.
 *
 * A word outside the three the schema documents is refused too, and named. `lib/fields.ts`
 * records that a status nobody knows is "invisible to every guard": it matches no
 * comparison in the application. A guard that matched it by falling through would be a
 * door that opens for anything it does not recognise, so an unrecognised word is answered
 * rather than trusted.
 */
export function retryAsk(status: string): RetryAsk {
  if (TERMINAL.includes(status)) return { ok: true };
  if (IN_FLIGHT.includes(status)) {
    return {
      ok: false,
      http: 409,
      error: `a ${status} job has not stopped yet — ${status === "PENDING"
        ? "the worker has not reached it, and it will run"
        : "a worker may be between rows on it right now"}; resuming would walk this crowd twice`,
    };
  }
  return {
    ok: false,
    http: 400,
    error: `"${status}" is not a status this application's schema documents, so no guard — including this one — can tell whether its worker is done`,
  };
}

/** The row a resume is taken from: only what the new row needs in order to mean the same job. */
export interface RetrySource {
  workspaceId: string;
  sourceId: string | null;
  type: string;
  status: string;
  config: unknown;
}

/**
 * What the resumed row carries: the crowd, the type, the workspace — and nothing about
 * the work done.
 *
 * `config` is copied unchanged because it *is* the job: for a named crowd it names the
 * same ids, for a condition it declares the same filter. A resume therefore re-walks the
 * set the operator meant rather than a remembered position inside it — there is no cursor
 * on this table, and inventing one would be a second arithmetic nobody checks. What makes
 * the second walk safe is the gate the visit itself obeys (`lib/enrich-plan.ts`: a column
 * the row already holds is left alone), so the rows a stop wrote come back refused and
 * recorded as refusals naming their gate, and the rows the mark left standing get written.
 *
 * What is deliberately not copied is the first row's account of itself — `progress`,
 * `totalItems`, `processedItems`, `failedItems`, `error`, `startedAt`, `completedAt`. A
 * stopped job reporting 3 of 300 counted would hand a job that has visited nothing a
 * denominator and a tally it did not earn, and `lib/job-report.ts` reads those numbers as
 * arithmetic. The new row starts at zero because that is what it has done.
 */
export function retryRow(job: RetrySource): {
  workspaceId: string;
  sourceId?: string;
  type: string;
  config: Prisma.InputJsonValue;
  status: "PENDING";
} {
  return {
    workspaceId: job.workspaceId,
    ...(job.sourceId ? { sourceId: job.sourceId } : {}),
    type: job.type,
    config: asInputJson(job.config),
    status: "PENDING",
  };
}
