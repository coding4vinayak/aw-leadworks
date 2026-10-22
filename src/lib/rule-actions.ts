import { ENRICH_WRITABLE } from "./enrich-plan";
import {
  canonicalSchedule,
  scheduleProblem,
} from "./cron-schedule";

/**
 * `EnrichmentRule.actions`, read as the promise its own comment makes.
 *
 * `prisma/schema.prisma` spells the column `actions Json // What enrichment to
 * perform`, and `RULE_CREATE` makes it **required** — a rule cannot be stored
 * without declaring what it does. Nothing read it back, and one place read it
 * *wrong*: `scheduler.ts` handed the whole JSON column to the minute matcher as a cron
 * string (`typeof rule.actions === "string" ? rule.actions : ""`), so the required
 * object became `""`, `parts.length < 5` became true, and the SCHEDULED leg of the
 * minute sweep returned false for every rule the API can create.
 *
 * Measured against the running app on a workspace holding leads whose titles state
 * a seniority:
 *
 * - two `MANUAL` rules over identical leads, one declaring `{ fields: ["industry"] }`
 *   and one declaring `{ fields: ["seniority"] }`, produced **the same row**: both
 *   wrote `seniority=C_LEVEL`, both left `industry` null, both logged
 *   `SUCCESS fieldsEnriched=["seniority"]`, and the job each carried had
 *   `fields: []` — the door never copied the declaration into it. The rule that
 *   asked for `industry` filled a column it had not asked for and left the one it
 *   had. The declaration was decoration.
 * - a `trigger: "SCHEDULED"` rule created through the door with the JSON the door
 *   demands queued **nothing** across the sweep's minutes, while the same rule with
 *   a cron string written straight into the column by hand fired on the next tick
 *   (one `COMPLETED` job, the lead `C_LEVEL`). The door itself refuses a string —
 *   `actions must be an object or an array, got a string` — so the one shape that
 *   works is a shape the product will not accept. Every rule in the database was
 *   scheduled and inert at the same time.
 *
 * Two rules about the rewrite, the same two `lib/rule-conditions.ts` states:
 *
 * - **A rule that declares nothing behaves as it always did.** An absent `fields`
 *   leaves the job's list empty, which the worker reads as "not scoped": the visit
 *   writes whatever a provider answers, exactly as before. Stored rows are not
 *   re-interpreted into something narrower than they were, and the single-lead door
 *   (`POST /api/leads/{id}?action=enrich`) declares no field list at all.
 * - **A declaration that cannot be honoured is refused at the door that took it.**
 *   `actionsProblem` reports every problem in one message; `POST /api/enrichment-rules`
 *   and its `PATCH` answer 400 with it, `?action=run` answers 400 rather than
 *   queuing a job the rule cannot describe, and the sweep skips the rule and logs
 *   why. A schedule this build's matcher can never match is the same failure as a
 *   condition no lead can ever satisfy: it looks like a quiet week.
 *
 * The vocabulary is the row's own: a field is one of `ENRICH_WRITABLE`, the columns
 * `lib/enrich-plan.ts` says an enrichment may fill, so the two halves of a visit —
 * what the rule asked for and what a write is allowed to be — are spelled from one
 * list. `schedule` is the five fields `lib/cron-schedule.ts` reads, and this module
 * imports the grammar rather than re-spelling it. Until #38 it also imported the
 * matcher's *limits*: a step (a star, a slash and a count) or a range (`1-5`) was
 * refused by name here because the matcher split each field on `,` and compared
 * whole strings, so such a rule could never fire. The matcher has learned those two shapes, which retires
 * this module's refusal of them and keeps every other one — a name, a `?`, a step of
 * `0`, a number outside its field, an empty entry, a sixth field are all still
 * refused here and now refused at the source door too, by the same call.
 */

/** The keys a rule is allowed to declare about itself. */
export const ACTION_KEYS = ["fields", "schedule"] as const;

/** What a rule says it does, once read. `null` on either half means "not declared". */
export interface RuleActions {
  /** The columns its visits may fill, or `null` when the rule says nothing about that. */
  fields: string[] | null;
  /** The cron its job is queued on, or `null` when no cadence is declared. */
  schedule: string | null;
}

/** The triggers that carry a cadence, and the ones that do not. */
const SCHEDULED_TRIGGER = "SCHEDULED";

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

function asFieldList(value: unknown): string[] | null {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") return null;
    const one = item.trim();
    if (!out.includes(one)) out.push(one);
  }
  return out;
}

/**
 * The column this word means, in the spelling the row uses. The names are camelCase
 * (`companySize`, `linkedinUrl`), so a caller typing `COMPANYSIZE` is reaching for a
 * real column and is stored the row's own word for it — measured, the first version of
 * this module folded to lowercase instead, and `{ fields: ["companySize"] }` came back
 * as "names companysize — an enrichment visit only writes …", refused by a rule that
 * had just quoted the column it was refusing. Two columns that differ only by case
 * would make this ambiguous; `ENRICH_WRITABLE` holds none.
 */
function canonicalColumn(word: string): string | null {
  const lowered = word.toLowerCase();
  return ENRICH_WRITABLE.find((column) => column.toLowerCase() === lowered) ?? null;
}

/**
 * Why this rule's `actions` cannot be honoured, every problem in one message, or
 * `null` when it can. Absent, `null` and `{}` all mean "the rule declares nothing",
 * which is the behavior every stored rule has had.
 */
export function actionsProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return `actions must be an object of what the rule does (${ACTION_KEYS.join(", ")}) — it is ${describe(value)}, which nothing performs`;
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(record)) {
    if (!(ACTION_KEYS as readonly string[]).includes(key)) {
      problems.push(`"${key}" is not something this build performs — the supported keys are ${ACTION_KEYS.join(", ")}`);
    }
  }

  if ("fields" in record) {
    const declared = record.fields;
    const list = declared === undefined ? null : asFieldList(declared);
    if (list === null) {
      const entries = Array.isArray(declared) ? (declared as unknown[]) : [declared];
      const bad = entries.filter((entry) => typeof entry !== "string" || entry.trim() === "");
      problems.push(Array.isArray(declared) && bad.length > 0
        ? `fields holds ${describe(bad[0])} among its values — every entry must be a column name`
        : `fields must be a list of the columns to fill — it is ${describe(declared)}`);
    } else if (list.length === 0) {
      problems.push("fields: [] asks for no column at all — drop the key to say nothing about what to enrich");
    } else {
      const unknown = list.filter((column) => canonicalColumn(column) === null);
      if (unknown.length > 0) {
        problems.push(`fields names ${unknown.map((column) => `"${column}"`).join(", ")} — an enrichment visit only writes ${ENRICH_WRITABLE.join(", ")}`);
      }
    }
  }

  if ("schedule" in record) {
    const problem = scheduleProblem(record.schedule);
    if (problem !== null) problems.push(problem);
  }

  return problems.length > 0 ? problems.join("; ") : null;
}

/**
 * The whole declaration refused, or `null`. This is what a door calls: the blob on
 * its own, and then the one pairing the blob cannot state — a cadence belongs to a
 * `SCHEDULED` rule and to nothing else, because no other trigger is ever swept.
 */
export function ruleDeclarationProblem(trigger: unknown, actions: unknown): string | null {
  const problem = actionsProblem(actions);
  const read = readRuleActions(actions);
  const pairing =
    trigger === SCHEDULED_TRIGGER && read.schedule === null
      ? `a ${SCHEDULED_TRIGGER} rule needs actions.schedule — this build sweeps ${SCHEDULED_TRIGGER} rules against a cron of five fields, and without one the rule is stored, active and never runs`
      : trigger !== SCHEDULED_TRIGGER && read.schedule !== null
        ? `actions.schedule means nothing to a rule whose trigger is not ${SCHEDULED_TRIGGER}: nothing sweeps it, so the cadence is stored and never honoured`
        : null;
  const problems = [problem, pairing].filter((one): one is string => one !== null);
  return problems.length > 0 ? problems.join("; ") : null;
}

/**
 * The rule's own words, or nothing at all when they cannot be read. `fields` is
 * `null` when the rule does not speak about columns — which the worker reads as "do
 * what you have always done" — and a list of real column names when it does.
 */
export function readRuleActions(value: unknown): RuleActions {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return { fields: null, schedule: null };
  }
  const record = value as Record<string, unknown>;
  const fields = "fields" in record ? asFieldList(record.fields) : null;
  const names: string[] = [];
  for (const word of fields ?? []) {
    const column = canonicalColumn(word);
    if (column !== null && !names.includes(column)) names.push(column);
  }
  const kept = fields === null ? null : names;
  const schedule = typeof record.schedule === "string" && scheduleProblem(record.schedule) === null
    ? canonicalSchedule(record.schedule)
    : null;
  return {
    fields: kept && kept.length > 0 ? kept : null,
    schedule,
  };
}

/**
 * The shape that is stored: the two keys this build performs, the columns folded to
 * the lowercase the row's own names use, the cadence in the single-space form the
 * matcher splits on. Doors refuse anything else outright; this is the backstop for a
 * caller that reaches for the shape without the verdict, so a stored rule never holds
 * a key nothing reads or a schedule nothing can match.
 */
export function normalizeActions(value: unknown): Partial<RuleActions> {
  const { fields, schedule } = readRuleActions(value);
  return { ...(fields === null ? {} : { fields }), ...(schedule === null ? {} : { schedule }) };
}

/**
 * What a provider answered, narrowed to what the rule asked for. The list can only
 * remove columns from an answer, never reorder what stays or add one the provider
 * did not give, and it is skipped entirely when nothing was declared. This is the
 * second of the two narrowings a visit passes through — `lib/enrich-plan.ts` then
 * decides which of the remaining columns the row will actually take.
 */
export function restrictToDeclared<T extends object>(answer: T, fields: readonly string[] | null | undefined): T {
  if (fields === null || fields === undefined || fields.length === 0) return answer;
  const kept: Record<string, unknown> = {};
  for (const column of Object.keys(answer)) {
    if (fields.includes(column)) kept[column] = (answer as Record<string, unknown>)[column];
  }
  return kept as T;
}
