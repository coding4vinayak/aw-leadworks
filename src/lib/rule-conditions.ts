import type { Prisma } from "@/generated/prisma/client";
import { LEAD_STATUSES } from "./enums";

/**
 * `EnrichmentRule.conditions`, read as the promise its own comment makes.
 *
 * `prisma/schema.prisma` spells the column `conditions Json // When to apply
 * this rule`, and `RULE_CREATE` makes it **required** — a rule cannot be created
 * without declaring when it applies. Nothing ever read it back. The three doors
 * that pick leads (`scheduler.ts`, the enrichment worker's `getLeadsToEnrich`, and
 * `runScheduledEnrichment`) each carried their own hardcoded
 * `status: { in: ["NEW", "ENRICHED"] }`, so
 * `{ status: "NEW" }` and `{ status: "CONVERTED" }` selected exactly the same
 * crowd: the declaration was decoration, and a rule named "Auto-enrich new
 * leads" (the seeded demo row, with the workspace the sales page shows a buyer)
 * did not mean its name.
 *
 * Two rules about the rewrite:
 *
 * - **A rule that says nothing is enriched the way LeadWorks has always
 *   enriched it.** An absent or empty `conditions` keeps the old `NEW | ENRICHED`
 *   set rather than widening to every lead in the workspace, including the ones
 *   already contacted and the ones deliberately rejected. Stored rows cannot be
 *   re-interpreted into something broader than they were.
 * - **A stored blob that cannot be read selects nothing.** The scheduler skips
 *   the rule and logs why, `?action=run` answers 400, and a job that was queued
 *   with such a config enriches nobody. Junk in a column that gates writes to a
 *   person's row is not a licence to fall back to "everything".
 *
 * The vocabulary is the `Lead` columns' own: `status` and `seniority` are the
 * values `schema.prisma` comments for them, `score` is the 0-100 the column
 * states, and `tags` is the JSON array the column is. The two enums are stored
 * uppercase, so they are upper-cased on the way in; a tag is free text and is kept
 * exactly as written, because the SQL side compares JSON values and `"VIP"` does not
 * contain `"vip"`. Keys come from
 * `CONDITION_KEYS` or the door refuses them by name — a filter on a column that
 * does not exist would match nothing forever, which is indistinguishable from a
 * rule that simply never found anyone.
 */

/** The seniorities `schema.prisma` spells for `Lead.seniority`. */
export const LEAD_SENIORITIES = ["IC", "MANAGER", "DIRECTOR", "VP", "C_LEVEL", "UNKNOWN"] as const;

/** The attributes a rule is allowed to speak about. */
export const CONDITION_KEYS = ["status", "seniority", "score", "tags"] as const;

export interface ScoreRange {
  gte?: number;
  lte?: number;
}

export interface RuleConditions {
  status?: string[];
  seniority?: string[];
  score?: ScoreRange;
  tags?: string[];
}

/** What a rule that declares nothing has always selected. */
export const DEFAULT_CONDITIONS: RuleConditions = { status: ["NEW", "ENRICHED"] };

/** One value or a list of them — the seeded row writes `{ status: "NEW" }`. */
function asList(value: unknown, toUpper = true): string[] | null {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") return null;
    const one = toUpper ? item.trim().toUpperCase() : item.trim();
    if (!out.includes(one)) out.push(one);
  }
  return out;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Why this declaration cannot be trusted, in the operator's terms, or `null`
 * when it can. Every problem is reported — the fleet's rule for a boundary that
 * could be filled in from a dashboard: one call names every key it will refuse.
 */
export function conditionsProblem(value: unknown): string | null {
  // Absent and `{}` both mean "the rule declares nothing", which is the old
  // behavior. `null` used to be storable too, and selected the same crowd.
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return `conditions must be an object of the attributes a lead must have (${CONDITION_KEYS.join(", ")}) — it is ${describe(value)}, which no lead can be`;
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(record)) {
    if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
      problems.push(`"${key}" is not an attribute a rule can condition on — the supported keys are ${CONDITION_KEYS.join(", ")}`);
    }
  }

  for (const key of ["status", "seniority", "tags"] as const) {
    if (!(key in record)) continue;
    // A tag is free text, not an enum: it is kept exactly as written, because the
    // Postgres side of the match (`array_contains`) compares JSON values, and
    // `"VIP"` contains no `"vip"`. Measured against the seeded workspace's own
    // `["vip", "dubai"]`: the lowercase probe returned 2 leads, the uppercase one 0.
    const list = asList(record[key], key !== "tags");
    const allowed = key === "status" ? (LEAD_STATUSES as readonly string[]) : key === "seniority" ? (LEAD_SENIORITIES as readonly string[]) : null;
    if (list === null) {
      // `["vip", ""]` is a list of values with one thing in it that is not, and a
      // caller told "must be a value or a list of values" about an array will go and
      // wrap the array again. Name the entry that is the problem.
      const entries = Array.isArray(record[key]) ? (record[key] as unknown[]) : [record[key]];
      const bad = entries.filter((e) => typeof e !== "string" || e.trim() === "");
      problems.push(Array.isArray(record[key]) && bad.length > 0
        ? `${key} holds ${describe(bad[0])} among its values — every entry must be a word`
        : `${key} must be a value or a list of values — it is ${describe(record[key])}`);
      continue;
    }
    if (list.length === 0) {
      problems.push(`${key}: [] asks for no lead at all — drop the key to say nothing about ${key}`);
      continue;
    }
    if (allowed) {
      const bad = list.filter((v) => !allowed.includes(v));
      if (bad.length > 0) {
        problems.push(`${key} names ${bad.map((b) => `"${b}"`).join(", ")} — the column spells ${allowed.join(" | ")}`);
      }
    }
  }

  if ("score" in record) {
    const score = record.score;
    if (typeof score !== "object" || score === null || Array.isArray(score)) {
      problems.push(`score must be an object of the bounds to apply — { gte, lte } — it is ${describe(score)}`);
    } else {
      const bounds = score as Record<string, unknown>;
      const unknown = Object.keys(bounds).filter((k) => k !== "gte" && k !== "lte");
      if (unknown.length > 0) problems.push(`score carries ${unknown.map((k) => `"${k}"`).join(", ")} — only gte and lte mean anything to a score`);
      const nums: Record<string, number> = {};
      for (const bound of ["gte", "lte"]) {
        if (!(bound in bounds)) continue;
        const n = bounds[bound];
        if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
          problems.push(`score.${bound} must be a whole number — it is ${describe(n)}`);
        } else if (n < 0 || n > 100) {
          problems.push(`score.${bound} is ${n} and the column is 0-100`);
        } else {
          nums[bound] = n;
        }
      }
      if (nums.gte !== undefined && nums.lte !== undefined && nums.gte > nums.lte) {
        problems.push(`score asks for at least ${nums.gte} and at most ${nums.lte} — no number is both`);
      }
      if (Object.keys(bounds).filter((k) => k === "gte" || k === "lte").length === 0 && unknown.length === 0) {
        problems.push("score carries neither bound — drop the key to say nothing about the score");
      }
    }
  }

  return problems.length === 0 ? null : problems.join("; ");
}

/**
 * The shape that is stored and shipped: single values become lists, the two
 * enums become the uppercase the column holds, and anything the column cannot hold is
 * dropped. The doors refuse such a blob outright; this is the backstop for a caller that
 * reaches for the shape without the verdict, so that a value no `Lead` row can ever carry
 * never becomes a stored rule that quietly selects nobody.
 */
export function normalizeConditions(value: unknown): RuleConditions {
  const out: RuleConditions = {};
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const record = value as Record<string, unknown>;
  const kept = (list: string[] | null, words?: readonly string[]): string[] | undefined => {
    if (list === null) return undefined;
    const ok = words === undefined ? list : list.filter((v) => words.includes(v));
    return ok.length > 0 ? ok : undefined;
  };
  const status = kept(record.status === undefined ? null : asList(record.status), LEAD_STATUSES as readonly string[]);
  const seniority = kept(record.seniority === undefined ? null : asList(record.seniority), LEAD_SENIORITIES as readonly string[]);
  const tags = kept(record.tags === undefined ? null : asList(record.tags, false));
  if (status) out.status = status;
  if (seniority) out.seniority = seniority;
  if (tags) out.tags = tags;
  if (record.score && typeof record.score === "object" && !Array.isArray(record.score)) {
    const bounds = record.score as Record<string, unknown>;
    const range: ScoreRange = {};
    for (const bound of ["gte", "lte"] as const) {
      const n = bounds[bound];
      if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100) range[bound] = n;
    }
    const inverted = range.gte !== undefined && range.lte !== undefined && range.gte > range.lte;
    if (!inverted && (range.gte !== undefined || range.lte !== undefined)) out.score = range;
  }
  return out;
}

/** The conditions a stored row actually carries, or the reason it carries none. */
export function readStoredConditions(value: unknown): { conditions: RuleConditions; problem: string | null; declared: boolean } {
  const problem = conditionsProblem(value);
  if (problem !== null) return { conditions: {}, problem, declared: false };
  const normalized = normalizeConditions(value);
  const declared = Object.keys(normalized).length > 0;
  return { conditions: declared ? normalized : DEFAULT_CONDITIONS, problem: null, declared };
}

/**
 * Exact, not case-folded: `normalizeConditions` puts the declaration in the case
 * `schema.prisma` spells, and the lead routes validate `status` and `seniority`
 * against those same words character for character, which is what the SQL `in`
 * list compares too. Folding here would be the one place the two readings of a
 * declaration could disagree.
 */
function matchesList(list: string[] | undefined, value: string | null | undefined): boolean {
  if (list === undefined) return true;
  return typeof value === "string" && list.includes(value);
}

/** The lead-shaped subset a condition can judge. */
export interface ConditionableLead {
  status?: string | null;
  seniority?: string | null;
  score?: number | null;
  tags?: unknown;
}

function leadTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t !== "");
  if (typeof value === "string") {
    try {
      return leadTags(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Does this lead satisfy the rule? Keys AND together, values within a key are
 * alternatives — the shape a filter has to be, and the shape the SQL below
 * compiles to, so the two readings of one declaration cannot disagree.
 */
export function leadMatches(conditions: RuleConditions, lead: ConditionableLead): boolean {
  if (!matchesList(conditions.status, lead.status)) return false;
  if (!matchesList(conditions.seniority, lead.seniority)) return false;
  if (conditions.score) {
    const score = typeof lead.score === "number" && Number.isFinite(lead.score) ? lead.score : null;
    if (score === null) return false;
    if (conditions.score.gte !== undefined && score < conditions.score.gte) return false;
    if (conditions.score.lte !== undefined && score > conditions.score.lte) return false;
  }
  if (conditions.tags && conditions.tags.length > 0) {
    const held = leadTags(lead.tags);
    if (!conditions.tags.some((t) => held.includes(t))) return false;
  }
  return true;
}

/**
 * The same declaration as one Prisma `where`. This is the only translation: the
 * scheduler and the enrichment worker both ask for it, so the door that names a
 * rule and the code that runs it read the column once, the same way.
 */
export function leadWhere(workspaceId: string, conditions: RuleConditions): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [{ workspaceId }];
  if (conditions.status) and.push({ status: { in: conditions.status } });
  if (conditions.seniority) and.push({ seniority: { in: conditions.seniority } });
  if (conditions.score) {
    const bounds: { gte?: number; lte?: number } = {};
    if (conditions.score.gte !== undefined) bounds.gte = conditions.score.gte;
    if (conditions.score.lte !== undefined) bounds.lte = conditions.score.lte;
    and.push({ score: bounds });
  }
  if (conditions.tags && conditions.tags.length > 0) {
    and.push({ OR: conditions.tags.map((tag) => ({ tags: { array_contains: tag } })) });
  }
  return { AND: and };
}

/** How a rule's promise reads when a door or a log has to say it out loud. */
export function describeConditions(conditions: RuleConditions): string {
  const parts: string[] = [];
  if (conditions.status) parts.push(`status ${conditions.status.join(" or ")}`);
  if (conditions.seniority) parts.push(`seniority ${conditions.seniority.join(" or ")}`);
  if (conditions.score) {
    const b: string[] = [];
    if (conditions.score.gte !== undefined) b.push(`>= ${conditions.score.gte}`);
    if (conditions.score.lte !== undefined) b.push(`<= ${conditions.score.lte}`);
    parts.push(`score ${b.join(" and ")}`);
  }
  if (conditions.tags) parts.push(`tagged ${conditions.tags.join(" or ")}`);
  return parts.length > 0 ? parts.join(", ") : "no conditions (every lead in the workspace)";
}
