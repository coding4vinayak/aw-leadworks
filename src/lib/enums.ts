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
 * `EnrichmentLog.status`, `LeadActivity.type`, `Source.lastRunStatus`,
 * `Membership.role` and `Invite.role` also have comment sets and also mean
 * something, but nothing in this API lets a caller write them — the workers and
 * the auth layer do — so declaring them here would be a table with no route
 * behind it.
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
