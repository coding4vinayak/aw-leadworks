/**
 * The string columns in `prisma/schema.prisma` that hold an enumerated value
 * document that value in a comment, because SQLite has no enum type and Prisma
 * has no way to check a `String` against a comment. So `type: "MOON"` is a clean
 * insert today, and the row is then invisible to every comparison the code
 * makes — the `status` filter on `GET /api/leads`, the exporter's `switch
 * (config.format)`, the cancel/retry guards in `api/jobs/[id]`.
 *
 * These arrays are transcribed from those comments and nothing else; where a
 * table here and the schema comment disagree, the schema is the one to fix. The
 * write routes validate against them (see `src/lib/validate.ts`) so that a value
 * outside the set answers 400 at the boundary instead of becoming a row that
 * silently does nothing.
 *
 * Only the sets a write route actually takes are listed. `JobResult.status`,
 * `EnrichmentLog.status`, `LeadActivity.type`, `Membership.role` and
 * `Invite.role` also have comment sets and also mean something, but nothing in this API
 * lets a caller write them — the workers and the auth layer do — so declaring them here
 * would be a table with no route behind it.
 *
 * Two of them got added anyway, for the same reason: a *reader* takes the word from a
 * query string, and a reader needs the vocabulary to judge it against. `EXPORT_STATUSES`
 * (#56, `GET /api/exports?status=`) and `SOURCE_RUN_STATUSES` (#63,
 * `GET /api/sources?lastRunStatus=`) are each transcribed from their schema comment and
 * pinned to it by a test.
 *
 * One of those sentences needed measuring: `JobResult.status` was listed as a set
 * the workers write, and no worker had ever written the table at all — 0 rows
 * across 475 jobs, behind a door that documents "detail + results". It is written
 * now, through `lib/job-report.ts`'s `RESULT_STATUSES`, which
 * `tests/unit/job-report.test.ts` compares against the schema comment this file is
 * transcribed from.
 */

/** Source.type */
export const SOURCE_TYPES = ["WEB_SCRAPER", "API", "DATABASE", "CSV_UPLOAD", "MANUAL"] as const;
/** Job.type */
export const JOB_TYPES = ["SCRAPE", "ENRICH", "EXPORT", "DEDUPE", "VALIDATE"] as const;
/** Job.status */
export const JOB_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
/** Lead.seniority */
export const LEAD_SENIORITIES = ["IC", "MANAGER", "DIRECTOR", "VP", "C_LEVEL", "UNKNOWN"] as const;
/** Lead.status */
export const LEAD_STATUSES = ["NEW", "ENRICHED", "QUALIFIED", "CONTACTED", "CONVERTED", "REJECTED"] as const;
/** EnrichmentRule.trigger */
export const RULE_TRIGGERS = ["ON_CREATE", "ON_UPDATE", "SCHEDULED", "MANUAL"] as const;
/** Export.format — `ExportProfile.format` carries the same set. */
export const EXPORT_FORMATS = ["CSV", "JSON", "XLSX", "PDF"] as const;
/**
 * Export.status. Not listed by the paragraph above's rule ("only the sets a write
 * route takes"), because no route writes it: `POST /api/exports` stores PENDING,
 * `exporter.ts` moves the row through PROCESSING to COMPLETED or FAILED, and
 * `exports/[id]` writes PENDING again on a retry. It is declared here because
 * #56 measured a *reader* that takes the word from a query string —
 * `GET /api/exports?status=` filtered the column against any word at all — and a
 * reader needs the same vocabulary the writers use. Transcribed from the schema
 * comment and pinned to it by `tests/unit/list-filter.test.ts`, the way
 * `RESULT_STATUSES` is pinned in `job-report.ts`.
 */
export const EXPORT_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
/**
 * `Source.lastRunStatus` — the verdict the last run of a source left behind.
 *
 * The opening paragraph's "nothing in this API lets a caller write them" still holds for
 * the write side: `scraper.ts:145` stamps `SUCCESS` and `scraper.ts:161` stamps `FAILED`,
 * and no route takes the column in a body. It is declared here because #63 measured a
 * *reader* that asks for it by word — `GET /api/sources` had never looked at
 * `?lastRunStatus=` at all, so every spelling of it, `FAILED`, `SUCCESS`, `PARTIAL`,
 * `nope`, answered the whole table on an instance whose scheduled source genuinely held a
 * `FAILED` row — the same class of defect `EXPORT_STATUSES` above was added for, and
 * treated the same way: transcribed from the schema comment, pinned to it, and judged by
 * `list-filter.ts`'s `filterParam` rather than a comparison of this file's own invention.
 *
 * `PARTIAL` is in this list because the schema comment says it is, and nothing here writes
 * it. That is a real disagreement and it is not smoothed over in either direction: the
 * word is accepted, because a caller asking whether any source half-ran is asking a
 * question this app can answer ("none ever have"), and the column is not quietly narrowed
 * to two words to make the table match the code. `tests/unit/source-filter.test.ts` pins
 * the transcription to the comment and pins the producers to the two words they stamp, so
 * the gap between them stays a measured fact rather than becoming a guess.
 */
export const SOURCE_RUN_STATUSES = ["SUCCESS", "FAILED", "PARTIAL"] as const;
