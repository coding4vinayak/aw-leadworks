import type { Field, Schema } from "./validate";
import { MAX_IMPORT_BYTES } from "./import-limits";
import { PRIORITY_MAX, PRIORITY_MIN } from "./rule-priority";
import {
  EXPORT_FORMATS,
  JOB_STATUSES,
  JOB_TYPES,
  LEAD_SENIORITIES,
  LEAD_STATUSES,
  RULE_TRIGGERS,
  SOURCE_TYPES,
} from "./enums";

/**
 * What each write route accepts, one declared table per route. It lives here
 * rather than beside its handler because the collection route and its `[id]`
 * sibling write the same columns — a source's `PATCH` and `POST` disagreeing
 * about what `type` may hold is exactly the kind of drift a table you can read
 * in one screen prevents. The API's whole input contract is this file.
 *
 * `workspaceId` and `id` are absent everywhere on purpose: they come from the
 * key and the path, never the body. A field not listed here never reaches
 * Prisma, which also retires the `...(name && { name })` shape every one of
 * these PATCHes used — measured, `PATCH {name:""}` answered 200 and left the
 * row's name alone.
 *
 * The tables are written out field by field rather than built from a helper,
 * because `validateBody` reads `kind` and `required` as literal types to work
 * out what each key holds; a function returning `Field` widens them and the
 * route loses the typing this is meant to give it.
 *
 * No `json` field below is `nullable`. Prisma writes a NULL in a JSON column
 * with its own `DbNull` sentinel rather than `null`, so "clear this" has no
 * shape a client can send that is not a translation at the boundary; `{}` is
 * the empty value in the same form every reader of those columns expects.
 *
 * Deliberately missing, because no handler has ever written them: `Lead.sourceRef`
 * and `Lead.validationResults` (the validator worker's), `Lead.lastEnrichedAt`
 * and `lastContactedAt` (the enrichment and the send's), `Job.progress` and its
 * four counters, `Source.lastRun*`, `Export.filePath`/`fileSize`/`recordCount`/
 * `completedAt` (the export worker's), `Webhook.secret`. Accepting one of those from a
 * request is a behaviour change and belongs in front of whoever owns that code,
 * not beside a type check. `Export.expiresAt` is missing for a different reason and
 * stays missing: the export worker stamps it from `EXPORT_RETENTION_MS` when the file
 * is written (#35), and a lifetime the requester chooses is not a retention policy.
 *
 * One output list lives here too, `WEBHOOK_READ_COLUMNS`: the same fact as the
 * paragraph above, read from the other side. `Webhook.secret` is neither an input
 * nor something a read door prints — it is handed out once, by the door that mints
 * it, and `secret` is exactly the column the two lists agree to leave out.
 */

/** The columns `Export.fields` may name: what the exporter can actually render. */
export const LEAD_EXPORT_FIELDS = [
  "id",
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
  "score",
  "status",
  "tags",
  "sourceId",
  "createdAt",
  "updatedAt",
] as const;

/** A column a read may be projected onto: the one vocabulary `Export.fields` names. */
export type LeadExportField = typeof LEAD_EXPORT_FIELDS[number];

/**
 * `?fields=` on `GET /api/lead-lists/{id}`, judged by the table above rather than
 * by a second list of names: what a caller can ask a list read to hand back is
 * exactly what the exporter can render, so adding a Lead column means editing
 * `LEAD_EXPORT_FIELDS` once and both doors following. The `strings` rules are the
 * ones the write door already uses — trim, refuse an empty entry, refuse a name
 * that is not a column, and treat a repeat as the same column asked for twice.
 */
export const LEAD_FIELD_PICK = {
  fields: { kind: "strings", required: true, min: 1, values: LEAD_EXPORT_FIELDS },
} satisfies Schema;

/**
 * `listIds` is not here: it names rows rather than filling a column, so the
 * route parses it with `asStrings` (the same array rule) and then checks each id
 * exists in this workspace. `tags`, `technologies` and `intentSignals` are here
 * because they are columns, and `dedupe.ts` spreads all three.
 */
export const LEAD_CREATE = {
  email: { kind: "text", nullable: true, format: "email", max: 254 },
  phone: { kind: "text", nullable: true, max: 32 },
  linkedinUrl: { kind: "text", nullable: true, format: "url", max: 500 },
  firstName: { kind: "text", nullable: true, max: 100 },
  lastName: { kind: "text", nullable: true, max: 100 },
  company: { kind: "text", nullable: true, max: 200 },
  title: { kind: "text", nullable: true, max: 200 },
  department: { kind: "text", nullable: true, max: 100 },
  seniority: { kind: "enum", nullable: true, values: LEAD_SENIORITIES },
  location: { kind: "text", nullable: true, max: 200 },
  country: { kind: "text", nullable: true, max: 100 },
  industry: { kind: "text", nullable: true, max: 200 },
  companySize: { kind: "text", nullable: true, max: 100 },
  revenue: { kind: "text", nullable: true, max: 100 },
  technologies: { kind: "strings" },
  intentSignals: { kind: "strings" },
  tags: { kind: "strings" },
  socialProfiles: { kind: "json" },
  customFields: { kind: "json" },
} satisfies Schema;

/**
 * `Lead.email`'s rule, on its own, for the doors that are not writing the column.
 *
 * `GET /api/leads?email=` compares this column to a value the caller typed into a
 * query string, and the only honest answer to "is that an address?" is the answer
 * `POST /api/leads` already gives — the same shape, the same 254-character cap, the
 * same refusal sentence — rather than a second rule invented for a URL.
 *
 * This widens the literals to `Field`, which is fine here and is not fine for the
 * tables above: a read door takes the value as a `string` and builds a `where`, so
 * it has no route typing to lose.
 */
export const LEAD_EMAIL: Field = LEAD_CREATE.email;

/**
 * `score` is the column whose comment says 0-100 and whose reader is
 * `GET /api/leads?orderBy=score desc`: measured, `PATCH {score: 9999}` was a 200
 * and put that lead first for every reader of the list. `status` is the value
 * every filter and campaign comparison is written against.
 *
 * A caller of this door does not write `Lead.score` — they write `scoreOverride`,
 * and `lib/lead-score.ts` computes the score from it beside the row's own signals
 * (`score: null` gives the override back). The range stays here because the column
 * it lands in is bounded by this door and by nothing else: the arithmetic needs no
 * clamp, since `SCORE_TERMS` sums to exactly 100.
 */
export const LEAD_PATCH = {
  ...LEAD_CREATE,
  score: { kind: "int", min: 0, max: 100, nullable: true },
  status: { kind: "enum", values: LEAD_STATUSES },
} satisfies Schema;

export const LEAD_LIST_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  // A Boolean column: `!!isDynamic` used to turn `isDynamic: "yes"` into true,
  // and `isDynamic: "no"` into true as well, because "no" is a non-empty string.
  isDynamic: { kind: "bool" },
  filterJson: { kind: "json" },
} satisfies Schema;

export const LEAD_LIST_PATCH = {
  name: { kind: "text", max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  isDynamic: { kind: "bool" },
  filterJson: { kind: "json" },
} satisfies Schema;

/**
 * `POST /api/leads/:id?action=add-to-list` takes one id, not a list, so it has
 * its own table rather than sharing `listIds`' parsing. `max` is the cuid width
 * the other id columns use: an over-long `listId` is a typo, and reading it back
 * as a `LeadList` lookup is cheaper than a unique-index failure.
 */
export const LEAD_ADD_TO_LIST = {
  listId: { kind: "text", required: true, max: 32 },
} satisfies Schema;

export const SOURCE_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  type: { kind: "enum", required: true, values: SOURCE_TYPES },
  // NOT NULL without a default, and the only field whose absence was a 500.
  config: { kind: "json", required: true },
  schedule: { kind: "text", nullable: true, max: 64 },
  isActive: { kind: "bool" },
} satisfies Schema;

export const SOURCE_PATCH = {
  name: { kind: "text", max: 200 },
  type: { kind: "enum", values: SOURCE_TYPES },
  config: { kind: "json" },
  schedule: { kind: "text", nullable: true, max: 64 },
  isActive: { kind: "bool" },
} satisfies Schema;

/**
 * `status` is not in the create table because the create has never taken it: a
 * new job is PENDING, and the workers move it on from there.
 *
 * `sourceId` is here as text so a `42` is refused by name, but it is a foreign
 * key, so the route also checks the source is in this workspace — measured,
 * `sourceId: "nope"` threw PrismaClientKnownRequestError, which is a 500.
 */
export const JOB_CREATE = {
  type: { kind: "enum", required: true, values: JOB_TYPES },
  config: { kind: "json", required: true },
  sourceId: { kind: "text", nullable: true, max: 32 },
} satisfies Schema;

/**
 * The cancel/retry guards in this route's POST compare against COMPLETED, FAILED
 * and CANCELLED exactly. A status outside the set is not a job in a new state,
 * it is a job no guard can see: measured, `PATCH {status: "DONE"}` stored it.
 */
export const JOB_PATCH = {
  status: { kind: "enum", values: JOB_STATUSES },
  config: { kind: "json" },
} satisfies Schema;

export const RULE_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  trigger: { kind: "enum", required: true, values: RULE_TRIGGERS },
  conditions: { kind: "json", required: true },
  actions: { kind: "json", required: true },
  // The `?action=run` branch copies this straight into the job it creates, and
  // the enrichment worker iterates it. `providers: "abc"` passed the old
  // `?.length` check, because a string has a length.
  providers: { kind: "strings", required: true, min: 1 },
  // The ranking `rule-priority.ts` walks. An `Int` column will hold anything a client
  // names, and a number spanning nine orders of magnitude is not a ranking — the range is
  // stated once, here and on the edit door, and both refusals quote it.
  priority: { kind: "int", min: PRIORITY_MIN, max: PRIORITY_MAX },
  isActive: { kind: "bool" },
} satisfies Schema;

export const RULE_PATCH = {
  name: { kind: "text", max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  trigger: { kind: "enum", values: RULE_TRIGGERS },
  conditions: { kind: "json" },
  actions: { kind: "json" },
  providers: { kind: "strings", min: 1 },
  priority: { kind: "int", min: PRIORITY_MIN, max: PRIORITY_MAX },
  isActive: { kind: "bool" },
} satisfies Schema;

/**
 * `format` is the one folded input in this API and it stays folded: the route has
 * upper-cased it since before this file existed, because `exporter.ts` switches
 * on the exact word and a stored `csv` is a job that ends FAILED after the
 * customer has already been given a job id. So `"csv"` still works; `"PDFX"`,
 * measured as a 201, does not.
 *
 * `fields` is checked against Lead's columns rather than just "an array of
 * strings" because the exporter renders `lead[field]`: a name that is not a
 * column is not an error there, it is an empty column in a downloaded file.
 */
export const EXPORT_CREATE = {
  format: { kind: "enum", required: true, values: EXPORT_FORMATS },
  fields: { kind: "strings", required: true, min: 1, values: LEAD_EXPORT_FIELDS },
  filterJson: { kind: "json" },
  profileId: { kind: "text", nullable: true, max: 32 },
} satisfies Schema;

/**
 * `events` is deliberately not here: it is the one input whose accepted JSON
 * shape (an array of names, or the comma-separated string the column actually
 * holds) differs from what gets stored, so `eventNames()` in the route checks it
 * and the handler decides the stored form.
 */
export const WEBHOOK_CREATE = {
  url: { kind: "text", required: true, format: "url", max: 2000 },
} satisfies Schema;

export const WEBHOOK_PATCH = {
  url: { kind: "text", format: "url", max: 2000 },
  isActive: { kind: "bool" },
} satisfies Schema;

/**
 * Every column of `model Webhook` except `secret` — the one list a webhook read
 * may hand back.
 *
 * `secret` is the HMAC key for deliveries, and before this it was printed by the
 * create door once (right) and by three more doors forever (wrong). Measured on
 * `main` before the change: `POST /api/webhooks` answered 201 with a 64-char
 * plaintext secret, and `GET /api/webhooks`, `GET /api/webhooks/{id}` and the
 * response of an unrelated `PATCH {isActive:false}` each printed the same value
 * again — 285 bytes for one subscription, 1,734 bytes with six, because the list
 * door prints one secret per row on every press. Three reads in a row returned one
 * distinct value, and no door could move it: `PATCH {secret:"…"}` was refused and
 * `POST` with a chosen secret stored its own. So the credential a subscriber
 * verifies a delivery with was re-issued by every read, with nothing that could
 * retire it short of deleting the row.
 *
 * This is the mouth, not the column. An API key is stored as its sha256 because
 * verification never needs the plaintext back; a signing secret cannot be, because
 * `webhooks.ts` HMACs the body with the value itself. What can be decided is which
 * door says it out loud, and the answer is one: the door that mints it.
 *
 * The list is written as what the row *is* rather than as a subtraction, so the
 * test can compare it against `model Webhook` itself: a column added to that model
 * is printed by the read doors by default, and only `secret` is withheld.
 */
export const WEBHOOK_READ_COLUMNS = [
  "id",
  "workspaceId",
  "url",
  "events",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export type WebhookReadColumn = typeof WEBHOOK_READ_COLUMNS[number];

/** The Prisma `select` that reads a subscription without its signing secret. */
export function webhookReadSelect(): Partial<Record<WebhookReadColumn, true>> {
  return Object.fromEntries(WEBHOOK_READ_COLUMNS.map((column) => [column, true])) as Partial<
    Record<WebhookReadColumn, true>
  >;
}

/**
 * The JSON envelope for `POST /api/leads/import`. The rows inside the CSV are
 * judged by `csv-parse.ts` using `LEAD_CREATE`; this table only guarantees the
 * request carries a string before the parser starts. The cap is the same
 * `MAX_IMPORT_BYTES` the route checks, in one shared place.
 */
export const LEAD_IMPORT = {
  csv: { kind: "text", required: true, max: MAX_IMPORT_BYTES },
} satisfies Schema;
