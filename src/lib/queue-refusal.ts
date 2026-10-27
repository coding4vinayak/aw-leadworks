import { prisma } from "./db";
import { QueueUnavailableError } from "./queue";

/**
 * What a refused enqueue leaves behind, and the one write that makes it truthful.
 *
 * Seven doors in this application insert a `Job` row and then hand it to the queue. Every
 * one of them catches `QueueUnavailableError` and answers 503 with the sentence
 * `lib/queue.ts` hands out — "the work is saved, retry shortly" — and `enqueueJob`'s own
 * docblock says the class exists so the caller "answers 503 rather than leaving the row
 * PENDING and reporting it as started". Measured on a running instance of this app, with
 * its queue turned off, that promise was false in both halves.
 *
 * | what was pressed, with Redis down | what the caller got | what the row says, minutes later |
 * |---|---|---|
 * | `POST /api/jobs` | `500`, **empty body**, 0 bytes | `PENDING`, `error: null`, nothing enqueued |
 * | `POST /api/exports` | `500`, empty body | a `PENDING` `Job` **and** a `PENDING` `Export` |
 * | `POST /api/leads/{id}?action=enrich` | `500`, empty body | `PENDING`, `totalItems: 1`, `report.problem`: "a denominator of 1 and nothing accounted for — this job **finished** without saying it visited any row" |
 * | `POST /api/enrichment-rules/{id}?action=run` | `500`, empty body | `PENDING` |
 * | `POST /api/sources/{id}?action=run` | `503` with the browser sentence | no row at all — this door refuses *before* it writes, and this round cannot always do that |
 * | `POST /api/jobs/{id}?action=retry` × 7, while Redis was still coming back | `500`, empty body | **seven more `PENDING` rows** |
 * | any of the five, on a process that started while Redis was already gone | **nothing** — the request never answers, and the row is written 300 ms in | `PENDING`, with a caller still waiting minutes later |
 *
 * So an outage produced eleven rows that no worker will ever run, and the 503 that was
 * supposed to describe one never arrived. The reason is two-shaped, and both shapes were
 * measured on this instance with a diagnostic printed from inside the door's own catch:
 *
 *   · Redis dies while the process runs. `queue.add` rejects in about a tenth of a second
 *     with ioredis's `Error: Stream isn't writeable and enableOfflineQueue options is
 *     false`. The classifier knew `connection is closed`, `connect ECONNREFUSED`, `stream
 *     disconnected` and three other sentences; it did not know this one. The rejection
 *     reached every door unclassified, the `instanceof QueueUnavailableError` branch never
 *     ran, and the row each door had already inserted was the last honest thing about the
 *     request: an unhandled 500 with no body — not even the sentence telling the caller to
 *     retry.
 *   · The process starts while Redis is already gone. Then `add` never settles at all. The
 *     row written by a `POST /api/jobs` at 09:15:27 was still `PENDING` three minutes later
 *     and the door had produced no response bytes; the driver's `AggregateError` — empty
 *     `message`, the two `connect ECONNREFUSED` lines on `.errors[]` — reached the log as an
 *     emitted error, never as a rejection to classify. No pattern can match a promise that
 *     does not settle, which is why `enqueue` now bounds the hand-off at 3 s and reads an
 *     expiry as the same refusal.
 *
 * And the rows that survived were not merely stale. `retryAsk` refuses a `PENDING` row with
 * 409 and the words "the worker has not reached it, **and it will run**" — a sentence this
 * application now believes, because it wrote it in #42 to stop an operator resuming a crowd
 * twice. Measured, the four doors plus the seven retries left 11 `PENDING` rows and after
 * 150 seconds of a healthy queue exactly 11 of them were still `PENDING`. The only door that
 * moved one was `PATCH {status: "FAILED"}` — a raw status write, after which
 * `?action=retry` answered 200 with a new `jobId` and the job ran. `POST /api/exports/{id}?action=retry`
 * answered 400 "Can only retry failed exports" for the export the outage left behind.
 *
 * That is the trap this module closes: a row the queue refused is not a job that has not
 * started yet, and every door that can resume a job refuses to resume it. The fix is to
 * say so at the moment of refusal — the row goes terminal, with the reason in the column
 * that holds reasons, so `?action=retry` and the export's own retry take it as the
 * ordinary retry case it now genuinely is.
 *
 * The alternative — enqueue first and insert the row only after — is what #39 does for the
 * browser capability, and it is not available here: the queue payload names the `Job` row
 * the worker must read, so the row has to exist before it can be handed over. Pre-generating
 * ids to invert that would change what five doors write, for a state that can already be
 * described honestly. And this application's own record of work is the `Job` table, not the
 * queue: `lib/queue.ts` deletes completed queue entries on exactly that grounds, so keeping
 * the refused row with the refusal on it is the same rule applied one state earlier.
 *
 * `lib/job-stop.ts` owns the write an operator's mark produces; this owns the write the
 * queue's refusal produces. Neither reads a row the other wrote, and both guard on the
 * status they expect to find, because a worker that already picked the row up must not be
 * answered by a refusal that landed too late.
 */

/** The sentence that goes into `Job.error` and `Export.error`. */
export const NEVER_QUEUED =
  'never queued: the queue refused this row while Redis was unreachable, so no worker was ever told it exists — retry it when the queue is back';

/** The columns a refused row is allowed to carry, and the guard that keeps a running one alone. */
export function refusalWrite(now: Date = new Date()): { status: "FAILED"; error: string; completedAt: Date } {
  return { status: "FAILED", error: NEVER_QUEUED, completedAt: now };
}

/**
 * Move a row the queue refused out of `PENDING`.
 *
 * `updateMany` with the status in its `where`, never `update`: matching nothing is the row
 * saying a worker took it in the window between the failed `add` and this statement, and a
 * refusal written over a live job would be the second lie this round exists to remove.
 */
export async function markNeverQueued(jobId: string, now: Date = new Date()): Promise<boolean> {
  const wrote = await prisma.job.updateMany({ where: { id: jobId, status: "PENDING" }, data: refusalWrite(now) });
  return wrote.count > 0;
}

/**
 * The same refusal on the `Export` row a queued export was written beside.
 *
 * `POST /api/exports/{id}?action=retry` reads "Can only retry failed exports" and answers
 * 400 for a `PENDING` one, which is the same dead end one table over: the export the outage
 * left behind could not be re-run by the door built to re-run it.
 */
export async function markExportNeverQueued(exportId: string, now: Date = new Date()): Promise<boolean> {
  const wrote = await prisma.export.updateMany({ where: { id: exportId, status: "PENDING" }, data: refusalWrite(now) });
  return wrote.count > 0;
}

/**
 * Hand a row the scheduled sweep just wrote to its worker, and mark it if the queue refuses.
 *
 * A door has a caller to answer to; the sweep does not. `runScheduledJobs` and its idle copy
 * mint rows for every due source, profile and rule, and each one of those `enqueue` calls used
 * to be unguarded — so a queue that goes away in the middle of a tick took the rest of the
 * minute with it and left the rows it had already written sitting at `PENDING`, which is the
 * state this module exists to refuse. Refusing here costs the tick one rule's job, says which
 * one in the log, and lets the next minute try again.
 */
export async function enqueueOrMark(jobId: string, hand: () => Promise<unknown>): Promise<boolean> {
  try {
    await hand();
    return true;
  } catch (error) {
    if (!(error instanceof QueueUnavailableError)) throw error;
    await markNeverQueued(jobId);
    console.warn(`Scheduled job ${jobId} was written and refused by the queue: ${error.message}`);
    return false;
  }
}
