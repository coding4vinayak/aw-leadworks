import { planRowDelete, type RowDeletePlan } from "./export-retention";

/**
 * What an export worker does with a mark it obeyed — the row it leaves behind, and the
 * bytes it may already have written.
 *
 * Measured before this file existed, on the running app, with the door an operator has:
 *
 * ```
 *   queued export C: job cmvjh9crc000537qcclvii6bv
 *   ?action=cancel on the queued EXPORT job -> 200 {"ok":true}
 *   +    97ms  Job[CANCELLED 0 0]   Export[COMPLETED /tmp/export_1792669709914.pdf 19]
 *   +   236ms  Job[COMPLETED 19 19] Export[COMPLETED /tmp/export_1792669709914.pdf 19]
 * ```
 *
 * The door answered `ok`, the row said the mark for 139 ms, and the worker wrote over it
 * twice: `status: "RUNNING"` the moment it took the job, and `status: "COMPLETED"` with
 * the file's size, count and lifetime at the end. That is the shape #41 named and left in
 * place on purpose — `lib/exporter.ts` was one of the two workers that do not consult the
 * mark — and #42 made it sharper, because a resume can only be taken from a row that *keeps*
 * a status a worker has put down. An export row never keeps one: the operator's stop is
 * erased before the door can be asked again, and meanwhile the two rows of one export
 * disagree (the Job cancelled, the Export COMPLETED, `export.completed` already on the wire).
 *
 * An export's indivisible unit of work is not a lead. It is the file: the crowd is read in
 * one query, rendered in memory, and written by one `writeFile`, so a stop between rows is
 * either "before the bytes" or "after the bytes", and the second case has a residue the
 * other three workers never produce — bytes on disk that no row will ever name. This file
 * decides both halves, and holds no query, no `unlink` and no status code.
 */

/**
 * The sentence a stopped export's row carries.
 *
 * Kept apart from `retiredExportError` ("this file's lifetime passed") and
 * `MISSING_EXPORT_FILE_ERROR` ("this server lost the bytes it promised") by a test, for the
 * reason #36 kept those two apart: three different facts about a file, and a caller who is
 * told the wrong one draws the wrong conclusion — nothing here expired, and nothing here
 * went missing. This export was stopped, and wrote nothing to serve.
 */
export const STOPPED_EXPORT_ERROR = "cancelled by the operator before the file was written — retry the export for a fresh one";

/** The `Export` write for a run that obeyed a mark. */
export interface StoppedExportWrite {
  status: "FAILED";
  error: string;
  filePath: null;
  fileSize: null;
  recordCount: number;
  expiresAt: null;
  completedAt: null;
}

/**
 * What the record says when its worker stopped: `FAILED`, with the cancel quoted as the
 * reason, and **every fact about a file written as nothing**.
 *
 * `FAILED` is one of the four words this column's own comment documents, and it is the word
 * that door — `POST /api/exports/{id}?action=retry` refuses anything else — so a stopped
 * export is resumable from the moment it stops, which is what #42's Job door can only do for
 * a row that keeps its mark. The five columns beside it are nulled rather than omitted
 * because this write can land on a row an earlier half of the same run had already stamped
 * `COMPLETED`: the finish and the stop are two writes about one file, the mark can fall
 * between them, and a row that says FAILED while still pointing at bytes that are being
 * deleted is a door answering `404` about a file the disk has and the row denies. A stopped
 * export names no bytes, no count, no lifetime and no completion; the `Job` row keeps the
 * arithmetic of the crowd it named (that is `job-stop`'s `stoppedWrite`).
 */
export function stoppedExportWrite(): StoppedExportWrite {
  return {
    status: "FAILED",
    error: STOPPED_EXPORT_ERROR,
    filePath: null,
    fileSize: null,
    recordCount: 0,
    expiresAt: null,
    completedAt: null,
  };
}

/**
 * What a stopped run does with bytes it already wrote.
 *
 * `planRowDelete` is the same question `DELETE /api/exports/{id}` asks — is this path one
 * this application could have produced — so "we only delete files we wrote" stays one rule in
 * one file rather than a second copy that can drift. `none` is not a failure: the file stays
 * on disk and is reported as staying, which is the honest third answer and the one #37's
 * census already counts as an unclaimed artifact.
 */
export function stoppedExportBytes(filePath: string | null | undefined): RowDeletePlan {
  return planRowDelete(filePath);
}
