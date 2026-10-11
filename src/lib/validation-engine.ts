/**
 * One validation engine, six envelopes.
 *
 * Measured before this file was written (`n28-measure`, 2026-10-09): the six
 * `src/lib/validate.ts` copies held 35 declarations, 19 of them in all six files,
 * and 13 of those 19 were already byte-identical once comments and whitespace are
 * stripped — including `validateBody` and the entire half of `collect` before its
 * `switch`, which is the part that decides what "absent", "null" and "required"
 * mean. What had drifted was five declarations, and four of them (`Field`,
 * `FieldKind`, `KindValue`, `collect`) had drifted in one direction only: each app
 * carries a *subset* of one grammar. `describe` had drifted the other way — three
 * apps still answer "a object" where the other three answer "an object", which is
 * not a subset of anything and was the bug this task started on.
 *
 * So the grammar is reunited here, as the union: eight kinds, every field option any
 * app had invented (`itemMax`, `pattern`, `objectOnly`, `format: "email" | "url"`),
 * and one wording per refusal. Where two copies worded the same rule differently the
 * engine says it once, and every such choice is either a grammar fix or a rule one
 * app already enforced and the others had not — the second kind makes this file
 * *stricter* than four of the six copies were, which is the direction the family
 * chose in #16 and is recorded per row in §8.46 of the ledger rather than hidden in
 * a diff.
 *
 * What deliberately stays per-app is the answer, not the rule: `abetapi` publishes
 * `{ error: { code, message }, fields }` at 422 because that envelope *is* its
 * product (`src/lib/openapi.ts`), and the other five answer `{ error: "…", fields }`
 * at 400 because that is what their clients read. Six apps agreeing about what a
 * wrong value *is* and disagreeing about how to say it is the fork this family
 * chose on purpose; `shared/check-validation-drift.sh` pins both halves of that —
 * the engine to bytes, each `src/lib/validate.ts` to the fact that it still
 * delegates here and still builds its own status.
 *
 * The one rule that is new rather than merged is the `default` arm at the bottom of
 * `collect`. A `switch` over `field.kind` with no `default` silently *drops* a field
 * whose kind it does not implement: no write, no refusal, and a caller told 201.
 * That is the exact failure mode the fork allowed — an app widening `FieldKind` in
 * its table without widening its collector, which the six separate copies made
 * possible in each other's silence — so the engine refuses it instead of assuming
 * the table and the collector still agree.
 */

export type FieldKind = "text" | "int" | "number" | "bool" | "date" | "enum" | "json" | "strings";

interface KindValue {
  text: string;
  int: number;
  number: number;
  bool: boolean;
  date: Date;
  enum: string;
  json: JsonObject | JsonArray;
  strings: string[];
}

/** Prisma's Json input is structurally this; `any` leaves the leaf types to it. */
export interface JsonObject {
  [key: string]: any;
}
export interface JsonArray extends Array<any> {}

export interface Field {
  kind: FieldKind;
  /** Absent is a problem. */
  required?: boolean;
  /** The column is nullable, so `null`, or blank text, clears it. */
  nullable?: boolean;
  /**
   * text: characters after trimming. strings: entries. int: the value.
   * json: serialised bytes.
   */
  min?: number;
  max?: number;
  /**
   * strings only: characters per entry. `max` counts the entries, and a list of
   * names needs both — a subscription could otherwise filter on a 5,000-character
   * event name that no published event could ever carry.
   */
  itemMax?: number;
  /**
   * enum and strings only: the members a caller may name, matched exactly.
   * SQLite has no enum type, so these words are the schema's comment and the
   * app's own `ALL_SCOPES`-style constant — Prisma reads the column as a plain
   * String, and a Json column as a plain array, which is how an unknown member
   * reached a write in every app that had no table to refuse it in.
   */
  values?: readonly string[];
  /**
   * text only. `url` is a http(s) address with a host, checked by `new URL` and
   * then by protocol; `email` is the lead pair's shape test. Both exist because
   * the route that *did* validate an address and the ones that did not should not
   * be different rules.
   */
  format?: "email" | "url";
  /** text and strings only: the whole value must match. `label` says what it wants. */
  pattern?: RegExp;
  /**
   * json only: refuse an array as well as a scalar. A Json column holds either,
   * so the kind allows both and the table says which one this column means.
   */
  objectOnly?: boolean;
  /** Name used in messages when the schema key is not the caller's word for it. */
  label?: string;
}

export type Schema = Record<string, Field>;

type ValueOf<F extends Field> = F["kind"] extends keyof KindValue ? KindValue[F["kind"]] : never;

/**
 * A required field is always filled. Anything else may be absent (not sent),
 * and may be null only where the table says the column is nullable — so a route
 * cannot spread a `null` into a NOT NULL column just because the caller left the
 * field out of `required`.
 */
export type Validated<S extends Schema> = {
  [K in keyof S]: S[K] extends { required: true }
    ? ValueOf<S[K]>
    : S[K] extends { nullable: true }
      ? ValueOf<S[K]> | null | undefined
      : ValueOf<S[K]> | undefined;
};

export type ValidationProblem = [field: string, message: string];

/**
 * The PATCH-that-changed-nothing answer. Measured as four 200s — one per
 * `[id]` PATCH route in abetapi plus the SSO one — each of which ran an UPDATE
 * whose data held nothing. The wording is part of what a client reads, so it
 * lives here once rather than in six files that can disagree about it.
 */
export const NO_FIELD_TO_UPDATE = "no field to update was sent";

/**
 * The engine's answer: the values to write, or the problems to report. It has no
 * `NextResponse` in it, because six apps do not agree about the status or the body
 * a problem becomes — and that disagreement is the part worth keeping.
 */
export type Collected<S extends Schema> =
  | { ok: true; data: Validated<S>; problems?: undefined }
  | { ok: false; data?: undefined; problems: ValidationProblem[] };

/** Where a Json column stops: 64 KB is past any real event payload. */
const DEFAULT_JSON_MAX_BYTES = 64 * 1024;
const DEFAULT_TEXT_MAX = 500;
/** A list's default length bound. Exported because an app's own list helper —
 * leadworks' `stringList`, which reads a query parameter rather than a body — has
 * to cap the same way the engine's `strings` kind does, or the two disagree about
 * how many tags a caller may send. */
export const DEFAULT_LIST_MAX = 100;

const EMAIL = /^[^\s@,;]+@[^\s@.,;]+(\.[^\s@.,;]+)+$/;

/**
 * Validate a parsed JSON body against a route's declared field table. Returns the
 * values to write, or the problems to answer with.
 *
 * `requireWrite` is for PATCH. Prisma answers an update whose `data` holds nothing
 * by returning the row untouched, which is a 200 for a request that asked for no
 * change and got none — indistinguishable from a successful write to the caller
 * who typed nothing and hit save.
 */
export function collectBody<S extends Schema>(
  body: unknown,
  schema: S,
  opts: { requireWrite?: boolean } = {},
): Collected<S> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, problems: [["body", `request body must be a JSON object, got ${describe(body)}`]] };
  }
  const out: Record<string, unknown> = {};
  const problems = collect(body as Record<string, unknown>, schema, out, "");
  if (opts.requireWrite && !problems.length && !Object.values(out).some((value) => value !== undefined)) {
    return { ok: false, problems: [["body", NO_FIELD_TO_UPDATE]] };
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, data: out as Validated<S> };
}

/* ---------- the per-field walk ---------- */

export function collect(source: Record<string, unknown>, schema: Schema, out: Record<string, unknown>, at: string): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const where = at ? `${at}.` : "";
  for (const [key, field] of Object.entries(schema)) {
    const name = `${where}${key}`;
    const label = at ? `${at} ${field.label ?? key}` : (field.label ?? key);
    const raw = source[key];

    if (raw === undefined) {
      if (field.required) problems.push([name, `${label} is required`]);
      continue;
    }
    if (raw === null) {
      if (field.kind === "json") {
        // Prisma stores a NULL in a Json column as `DbNull`, not `null`, and a
        // caller who sends JSON null almost always means "nothing in here".
        // `{}` says that in the same shape every reader of the column expects,
        // so the boundary refuses the ambiguous one rather than translating it.
        problems.push([name, `${label} cannot be null — send {} to clear it, or omit the key to leave it alone`]);
      } else if (field.nullable) out[key] = null;
      else if (field.required) problems.push([name, `${label} is required and cannot be null`]);
      else problems.push([name, `${label} cannot be null; omit it to leave the value alone`]);
      continue;
    }

    switch (field.kind) {
      case "text": {
        if (typeof raw !== "string") {
          problems.push([name, `${label} must be text, got ${describe(raw)}`]);
          break;
        }
        const value = raw.trim();
        // Blank is how a form posts "I cleared this". A NOT NULL column has
        // nothing to clear to, so there it stays an error rather than "".
        if (value === "") {
          if (field.nullable) out[key] = null;
          else problems.push([name, `${label} must be a non-empty string`]);
          break;
        }
        // Length before shape: an over-long value's first problem is its length,
        // and echoing forty characters of a 5,000-character "URL" answers the
        // wrong question.
        const max = field.max ?? DEFAULT_TEXT_MAX;
        if (value.length > max) {
          problems.push([name, `${label} is ${value.length} characters; at most ${max}`]);
          break;
        }
        if (field.min !== undefined && value.length < field.min) {
          problems.push([name, `${label} must be at least ${field.min} characters`]);
          break;
        }
        if (field.format === "email" && !EMAIL.test(value)) {
          problems.push([name, `${label} does not look like an email address: ${short(value)}`]);
          break;
        }
        if (field.format === "url" && !isHttpUrl(value)) {
          // `new URL` alone is not enough: it accepts `javascript:` and `file:`,
          // which a signer would happily POST to. Measured, the route this
          // replaces did get the protocol right and the *type* wrong —
          // `String(["https://x"])` is a URL, so an array of one became an
          // address. Hence the typeof test above staying in front of this.
          problems.push([name, `${label} must be an http(s) URL, got ${short(value)}`]);
          break;
        }
        if (field.pattern && !field.pattern.test(value)) {
          problems.push([name, `${label} does not match ${field.pattern.source}: ${short(value)}`]);
          break;
        }
        out[key] = value;
        break;
      }
      case "int":
      case "number": {
        // One block for both, because the rule is one rule: a JSON number, and for
        // `int` a whole one. `1e21` is whole and measured as a 500 — Prisma binds
        // an `Int` field by truncating, and past `2**53` the value is not a number
        // JavaScript can name — so `int` also has a ceiling whether the table gave
        // it one or not.
        const whole = field.kind === "int";
        const looksNumeric = typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw));
        if (typeof raw !== "number" || !Number.isFinite(raw) || (whole && !Number.isInteger(raw))) {
          problems.push([
            name,
            `${label} must be ${whole ? "a whole number" : "a finite number"}, got ${
              looksNumeric ? `"${String(raw)}" as text — send it unquoted` : describe(raw)
            }${whole && typeof raw === "number" && Number.isFinite(raw) ? " — send it without a fraction" : ""}`,
          ]);
          break;
        }
        const max = whole ? (field.max ?? Number.MAX_SAFE_INTEGER) : field.max;
        if (max !== undefined && raw > max) {
          problems.push([name, `${label} must be at most ${max}`]);
          break;
        }
        if (field.min !== undefined && raw < field.min) {
          problems.push([name, `${label} must be at least ${field.min}`]);
          break;
        }
        out[key] = raw;
        break;
      }
      case "enum": {
        const allowed = field.values ?? [];
        if (typeof raw !== "string" || !allowed.includes(raw)) {
          problems.push([
            name,
            `${label} must be one of ${allowed.join(" | ")}${
              typeof raw === "string" ? `, got ${short(raw)}` : `, got ${describe(raw)}`
            }`,
          ]);
          break;
        }
        out[key] = raw;
        break;
      }
      case "strings": {
        // A Json column holding a list of names — scopes, event filters, tags.
        // The routes that read one either filtered the unknown members out or
        // checked-then-stored, so a wrong element produced a *different* list and
        // named nothing. Every problem here says which index, and nothing is
        // dropped: a duplicate a caller sent is a duplicate that gets stored,
        // because silently de-duplicating is the same quiet rewrite as silently
        // filtering.
        if (!Array.isArray(raw)) {
          problems.push([name, `${label} must be an array of strings, got ${describe(raw)}${typeof raw === "string" ? " — send it as a one-element array" : ""}`]);
          break;
        }
        const max = field.max ?? DEFAULT_LIST_MAX;
        if (raw.length > max) {
          problems.push([name, `${label} holds ${raw.length} entries; at most ${max}`]);
          break;
        }
        if (field.min !== undefined && raw.length < field.min) {
          problems.push([name, `${label} must hold at least ${field.min === 1 ? "one entry" : `${field.min} entries`}`]);
          break;
        }
        // A repeat is not a second value: `["b", " b "]` is one membership, and
        // dropping it removes nothing the caller asked for — unlike filtering an
        // *unknown* member, which is what `values` is for and what this family's
        // own rule refuses. Every app that had a list of names already read it as
        // a set (`mergeLeads` dedupes tags, `scopes` and `events` are matched with
        // `includes`), so the set is the shared rule and the engine applies it.
        const allowed = field.values;
        const items: string[] = [];
        let refused = false;
        raw.forEach((item, i) => {
          const atItem = `${name}[${i}]`;
          if (typeof item !== "string") {
            problems.push([atItem, `${atItem} must be text, got ${describe(item)}`]);
            refused = true;
            return;
          }
          const value = item.trim();
          if (value === "") {
            problems.push([atItem, `${atItem} must be a non-empty string`]);
            refused = true;
            return;
          }
          if (field.itemMax !== undefined && value.length > field.itemMax) {
            problems.push([atItem, `${atItem} is ${value.length} characters; at most ${field.itemMax}`]);
            refused = true;
            return;
          }
          if (allowed && !allowed.includes(value)) {
            problems.push([atItem, `${atItem} must be one of ${allowed.join(" | ")}, got ${short(value)}`]);
            refused = true;
            return;
          }
          if (field.pattern && !field.pattern.test(value)) {
            problems.push([atItem, `${atItem} does not match ${field.pattern.source}: ${short(value)}`]);
            refused = true;
            return;
          }
          if (!items.includes(value)) items.push(value);
        });
        if (refused) break;
        out[key] = items;
        break;
      }
      case "json": {
        if (typeof raw !== "object") {
          problems.push([name, `${label} must be an object or an array, got ${describe(raw)}`]);
          break;
        }
        if (field.objectOnly && Array.isArray(raw)) {
          problems.push([name, `${label} must be an object, got an array`]);
          break;
        }
        const bytes = jsonByteLength(raw);
        if (bytes === null) {
          problems.push([name, `${label} is not JSON-serialisable`]);
          break;
        }
        const max = field.max ?? DEFAULT_JSON_MAX_BYTES;
        if (bytes > max) {
          problems.push([name, `${label} is ${bytes} bytes of JSON; at most ${max}`]);
          break;
        }
        out[key] = raw;
        break;
      }
      case "bool": {
        // The whole reason this kind exists: `Boolean(isActive)` turned `"no"`,
        // `[]` and `42` into `true`, and `""` and `null` into `false` — so one
        // spelling switched a live subscription off and another kept it on, and
        // neither answer mentioned the field. The wording matches `boolFlag`, the
        // route-control spelling of the same rule, so a caller gets one sentence.
        if (typeof raw !== "boolean") {
          problems.push([
            name,
            `${label} must be true or false, got ${describe(raw)}${
              typeof raw === "string" ? " — send it unquoted" : ""
            }`,
          ]);
          break;
        }
        out[key] = raw;
        break;
      }
      case "date": {
        // A bare number is refused rather than read as epoch-milliseconds:
        // Prisma's answer to `startDate: 42` was a 201 dated 1970-01-01.
        if (typeof raw !== "string") {
          problems.push([name, `${label} must be an ISO 8601 date string, got ${describe(raw)}`]);
          break;
        }
        if (raw.trim() === "") {
          // The same rule as blank text: an emptied date input means "no date".
          if (field.nullable) out[key] = null;
          else problems.push([name, `${label} must be a date, not blank`]);
          break;
        }
        const time = Date.parse(raw);
        if (!Number.isFinite(time)) {
          problems.push([name, `${label} is not a date: ${short(raw)}`]);
          break;
        }
        out[key] = new Date(time);
        break;
      }
      default: {
        // Unreachable while `FieldKind` is the only source of kinds, and the point
        // of writing it anyway: the six separate collectors each had a `switch` with
        // no `default`, so a table that named a kind its own collector had not
        // implemented was *silently dropping that field* — no write, no refusal, a
        // 201 for a request whose value went nowhere. A dropped field is the one
        // outcome this family's own rules say cannot be answered quietly, and here
        // it is also the outcome a future edit re-introduces first.
        problems.push([name, `${label} declares a kind no engine implements: ${String(field.kind)}`]);
        break;
      }
    }
  }
  return problems;
}

/* ---------- internals, exported because an app's own helpers phrase problems with them ---------- */

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  // `typeof null` is "object" and `typeof []` is "object", both handled above;
  // what is left needs the article to agree with the noun, because this word is
  // the client's whole answer — "must be text, got a object" reads like a typo in
  // someone else's code and sends them looking for the bug in their own request.
  const kind = typeof value;
  return kind === "object" ? "an object" : `a ${kind}`;
}

export function short(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 40 ? `"${trimmed.slice(0, 40)}…"` : `"${trimmed}"`;
}

export function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text, "utf8") : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname;
  } catch {
    return false;
  }
}
