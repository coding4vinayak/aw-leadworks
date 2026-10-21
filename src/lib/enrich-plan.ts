/**
 * What an enrichment visit is allowed to write to a lead — decided in one place,
 * because every other path to that row either threw or invented.
 *
 * The worker used to spread whatever a provider returned straight into
 * `prisma.lead.update`: `{ ...result, lastEnrichedAt, score }`. Two things came of
 * that. The placeholder providers answer with a `confidence` number, which is not a
 * column on `Lead`, so Prisma refused the whole update and every lead the rule
 * named was counted in `Job.failedItems` — a job that did nothing wrong reporting
 * itself as failing, and enrichment, the product's headline feature, writing no row
 * for anybody. And had it not thrown, the same spread would have stored `score: 5`
 * over a lead whose real signals earned 82, because the score was computed from the
 * provider's return value rather than from the row.
 *
 * So this module owns three decisions the worker used to make implicitly:
 *
 * - **Only a real column is written, and only into a gap.** `ENRICH_WRITABLE` is
 *   the set of `Lead` columns an enrichment may fill. A field the row already holds
 *   is left alone — a value a person typed, imported or corrected outlives anything
 *   a provider guessed — so an enrichment is *additive* and running it twice changes
 *   nothing the first run did. A value whose shape the column cannot hold (a bare
 *   string where `technologies` is an array) is dropped rather than coerced: the log
 *   row carries what the provider said, so a mismatch is visible instead of quietly
 *   reshaped into something that looks like data.
 * - **`score` is recomputed, never received.** A visit may fill the columns the
 *   score is made of, so the score follows them — through `lib/lead-score.ts`,
 *   which owns that arithmetic. Nothing here takes a score from a provider: a
 *   third party's guess about a company is not the number a buyer sorts a list by.
 *   `status` moves in exactly one direction:
 *   a lead that was `NEW` and gained a field is now what the schema's own word for
 *   that calls `ENRICHED`. A qualified, contacted, converted or rejected lead is
 *   never pulled back to an enrichment status by a background job, and `UNKNOWN`
 *   seniority is left to a person.
 * - **A visit that learned nothing says so.** `lastEnrichedAt` is the honest stamp
 *   of "the worker looked at this row", so it is written either way, while the log's
 *   status is `PARTIAL` when no column was filled. That is the true state of every
 *   provider in this build except `derive`, and a log line that claimed `SUCCESS`
 *   would be the second way this job lied.
 */

import type { Prisma } from "@/generated/prisma/client";
import { rowAfterWrite, scoredWriteData } from "./lead-score";

/**
 * The columns an enrichment may fill. Absent on purpose: `id`, `workspaceId`,
 * `sourceId`, `sourceRef`, `status`, `tags`, `validationResults`,
 * `lastContactedAt`, `createdAt` and `updatedAt`, and the three columns
 * `lib/lead-score.ts` owns (`score`, `scoreOverride`, `scoreBreakdown`) — the first
 * group belongs to the row's identity, the rest to workspaces, lists, validation
 * and the sales process, and a provider's business is none of them. A visit fills
 * signal columns and the score follows; it does not receive a number.
 */
export const ENRICH_WRITABLE = [
  "email",
  "phone",
  "linkedinUrl",
  "firstName",
  "lastName",
  "company",
  "title",
  "department",
  "seniority",
  "location",
  "country",
  "industry",
  "companySize",
  "revenue",
  "technologies",
  "intentSignals",
  "socialProfiles",
  "customFields",
] as const;

/** The Json columns that hold a list of words. */
const ARRAY_COLUMNS: readonly string[] = ["technologies", "intentSignals"];
/** The Json columns that hold a map of strings. */
const MAP_COLUMNS: readonly string[] = ["socialProfiles", "customFields"];

/** The shape a provider's answer arrives in: the row's own columns, loosely. */
export type EnrichableLead = { status: string } & Record<string, unknown>;

export interface EnrichmentPlan {
  /** What goes into `prisma.lead.update`'s `data`. Never carries a non-column. */
  data: Prisma.LeadUpdateInput;
  /** The columns this visit filled, in the order the provider named them. */
  written: string[];
  /** `EnrichmentLog.status` — see the module docblock. */
  logStatus: "SUCCESS" | "PARTIAL";
}

/** Whether the row already holds a value in this column. */
function holds(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Whether the provider's value is one this column can hold. */
function fits(column: string, value: unknown): boolean {
  if (ARRAY_COLUMNS.includes(column)) {
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "");
  }
  if (MAP_COLUMNS.includes(column)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.values(value as Record<string, unknown>);
    return entries.length > 0 && entries.every((item) => typeof item === "string" && item.trim() !== "");
  }
  // The remaining columns hold one word. A number, a list or an object is not that,
  // and a bare `42` is not written into a column that a buyer reads as text.
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The update a visit should perform, or the honest small one it should perform
 * when it learned nothing.
 *
 * `result` is what the providers agreed on; anything that is not a writable column
 * (`confidence`, a provider's raw payload, a name typed by someone who read a
 * different product's docs) is not written anywhere near the row. The score is
 * written by every plan, from the row as the plan leaves it: filling a column that
 * the score is made of and leaving the number stale would put the buyer's sort
 * order behind the data it is supposed to reflect.
 */
export function planEnrichmentWrite(lead: EnrichableLead, result: Record<string, unknown> | null | undefined): EnrichmentPlan {
  const data: Record<string, unknown> = { lastEnrichedAt: new Date() };
  const written: string[] = [];
  const answers = result ?? {};

  for (const column of ENRICH_WRITABLE) {
    const value = answers[column];
    if (value === undefined || value === null) continue;
    if (holds(lead[column])) continue;
    if (!fits(column, value)) continue;
    data[column] = value;
    written.push(column);
  }

  // The one status an enrichment earns: the schema spells `ENRICHED` in the set
  // `Lead.status` comments, and this is the only code in the product that moves a
  // row into it. Only from `NEW`, and only when a column actually filled.
  if (written.length > 0 && lead.status === "NEW") data.status = "ENRICHED";

  // The row as this plan leaves it, which is what the score has to be computed
  // from — computing it from `lead` would stamp the visit with the number the
  // signals *before* the visit were worth.
  return {
    data: { ...data, ...scoredWriteData(rowAfterWrite(lead, data)) } as Prisma.LeadUpdateInput,
    written,
    logStatus: written.length > 0 ? "SUCCESS" : "PARTIAL",
  };
}
