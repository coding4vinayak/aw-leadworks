import { NextResponse } from "next/server";

/**
 * A wrong-typed scalar used to be the database's problem, and the database
 * answers in one of two unhelpful ways. The table below is what leadworks' write
 * routes did before this existed. Every row was measured, and where it says how
 * — [probe] is a real call through the exported handler with a valid key and an
 * otherwise-valid body (`/tmp/abectorial/n5-lw-before.mts`, 71 cases, 0 FAIL),
 * [code] is something only readable in the source, like a missing `enqueue`.
 * `0 THREW` means the handler threw instead of returning a Response; over HTTP
 * Next makes that a 500.
 *
 *   POST /api/leads          email: 42                 0 THREW PrismaClientValidationError  [probe]
 *   POST /api/leads          email: "not an address"   201  — stored as the email           [probe]
 *   POST /api/leads          email: "a@b"              201  — a dotless domain               [probe]
 *   POST /api/leads          linkedinUrl: "javascript:alert(1)"  201                         [probe]
 *   POST /api/leads          seniority: "BOSS"         201  — outside the comment's set      [probe]
 *   POST /api/leads          customFields: 42          201  — a number in a Json column      [probe]
 *   POST /api/leads          socialProfiles: "x"       201                                    [probe]
 *   POST /api/leads          firstName: 6000 chars     201                                    [probe]
 *   POST /api/leads          listIds: ["nope"]         422                                    [probe]
 *   POST /api/sources        schedule: 42              0 THREW PrismaClientValidationError    [probe]
 *   POST /api/sources        isActive: "yes"           0 THREW PrismaClientValidationError    [probe]
 *   POST /api/sources        type: "MOON"              201                                    [probe]
 *   POST /api/sources        config: 42                201                                    [probe]
 *   POST /api/jobs           sourceId: 42              0 THREW PrismaClientValidationError    [probe]
 *   POST /api/jobs           sourceId: "nope"          0 THREW PrismaClientKnownRequestError  [probe]
 *   POST /api/exports        profileId: 42             0 THREW PrismaClientValidationError    [probe]
 *   POST /api/exports        profileId: "nope"         0 THREW PrismaClientKnownRequestError  [probe]
 *   POST /api/exports        format: 42                0 THREW PrismaClientValidationError    [probe]
 *   POST /api/exports        format: "PDFX"            201  — a FAILED export, later          [probe]
 *   POST /api/exports        fields: "abc"             201  — the exporter loops its letters  [probe]
 *   POST /api/webhooks       url: 42                   0 THREW PrismaClientValidationError    [probe]
 *   POST /api/webhooks       url: "javascript:alert(1)"  201                                   [probe]
 *   POST /api/webhooks       events: ["a.b","c.d"]     0 THREW — the column is a String       [probe]
 *   POST /api/webhooks       events: 42                400 "url, events required"             [probe]
 *   POST /api/lead-lists     name: 42                  0 THREW PrismaClientValidationError    [probe]
 *   POST /api/lead-lists     isDynamic: "yes"          201  — stored true, via `!!`           [probe]
 *   POST /api/lead-lists     filterJson: 42            201                                     [probe]
 *   POST /api/enrichment-rules  priority: "2"          0 THREW PrismaClientValidationError    [probe]
 *   POST /api/enrichment-rules  providers: "abc"       201  — `?.length` is 3 on a string     [probe]
 *   POST /api/enrichment-rules  conditions: 42         201                                     [probe]
 *   PATCH /api/leads/:id     score: "50"               0 THREW PrismaClientValidationError    [probe]
 *   PATCH /api/leads/:id     score: 9999               200  — and the lead sorts #1 of 20     [probe]
 *   PATCH /api/leads/:id     status: "DONE"            200  — no reader will match it         [probe]
 *   PATCH /api/leads/:id     {} or {nope:1}            200  — the row, unchanged              [probe]
 *   PATCH /api/sources/:id   name: ""                  200  — dropped by `&&`, unchanged      [probe]
 *   PATCH /api/lead-lists/:id  name: ""                200  — same spread, same nothing       [probe]
 *   PATCH /api/jobs/:id      status: "DONE"            200                                     [probe]
 *   PATCH /api/jobs/:id      config: 42                200                                     [probe]
 *   PATCH /api/webhooks/:id  events: ["a.b"]           0 THREW — the column is a String       [probe]
 *   POST /api/exports/:id?action=download   (no Authorization header at all)
 *                           200 {"downloadUrl": "/api/exports/…"}  [probe]
 *   POST /api/lead-lists/:id  (no body, or `prose`)  0 THREW SyntaxError — a
 *                           client that cannot write JSON got a server fault  [probe]
 *   POST /api/enrichment-rules/:id?action=run  200 {"jobId"}, row PENDING, no enqueue  [probe+code]
 *   POST /api/jobs/:id?action=retry  200 {"jobId"}, row PENDING, file imports `queues`
 *                                    and never calls it                            [probe+code]
 *
 * A 500 is the one status a correct client retries, against a request that will
 * fail identically forever. The 201s are worse: `score: 9999` is stored without
 * complaint and then reorders the lead list for every reader, `fields: "abc"`
 * becomes a spreadsheet with columns a, b and c, and `status: "DONE"` is a lead
 * no filter, no campaign and no dashboard can see, because every comparison in
 * the app is against the words in the schema comment. Prisma validates the types
 * it was told about (String, Int, DateTime) and not the ones it was not — those
 * enum-ish columns are plain Strings, so `type: "MOON"` is a clean insert today.
 *
 * So the check belongs at the boundary, against a declared table per route:
 *
 *  - No coercion. `String(42)` into a text field turns a client bug into the
 *    value "42", which is the same silent corruption coming the other way.
 *  - An absent key means "not mentioned" and is omitted, so a PATCH cannot
 *    reset a column the caller never named. `null` means "clear it" and only
 *    works where the column is nullable.
 *  - Every problem is reported at once, named by field. A caller who sent four
 *    bad fields and is told about one needs four round trips to learn the API.
 *  - Text is trimmed. `email: " a@b.co "` passes a type check, then defeats
 *    `@@unique([workspaceId, email])` and every later lookup by address.
 *  - A field the route did not declare never reaches Prisma. That is what the
 *    `sourceId: "nope"` rows above are: an id passed on faith to a `create`.
 *
 * A Json column is where this rule stops: `kind: "json"` can say a value is an
 * object, and nothing about what the object means. `{ department: "Ops" }` in
 * `EnrichmentRule.conditions` was a 201 through every version of this file, and a
 * rule that would never match a lead — so that column has a second check of its own
 * in `src/lib/rule-conditions.ts`, which is where the row's *meaning* is decided.
 * Same 400, same "every problem at once", one file per column that needs it.
 *
 * This is `src/lib/ids.ts` for the rest of the request — and now the same rule:
 * `asStrings` there calls `stringList` here, so an array of strings is checked
 * one way whether it is `listIds`, `tags` or `providers`. `withAuth` deliberately
 * stays an error boundary rather than growing a global
 * `PrismaClientValidationError -> 400`, because that net would also swallow a
 * validation error our own code causes — which is a bug, and wants to be loud.
 *
 * This is `src/lib/validate.ts` in leadgenius, same engine. Two kinds are
 * carried here for that parity and are unused by leadworks' tables: `date`
 * (no leadworks write route takes a caller's timestamp — `grep new Date` across
 * the handlers finds one, and it is the server's own `completedAt`) and
 * `validateItems` (no leadworks column stores an array of caller objects).
 * Where a claim in the block above comes from leadgenius' measurement rather
 * than leadworks', the line says so.
 *
 * Not to be confused with `src/lib/validator.ts`, which is the VALIDATE *job*
 * worker that checks email deliverability. This file validates HTTP requests.
 */

import { DEFAULT_LIST_MAX, collect, collectBody, describe, short } from "./validation-engine";
import type { Schema, Validated, ValidationProblem } from "./validation-engine";

export type { FieldKind, Field, JsonObject, JsonArray, Schema, Validated, ValidationProblem } from "./validation-engine";
export { NO_FIELD_TO_UPDATE } from "./validation-engine";


export type Validation<S extends Schema> =
  | { ok: true; data: Validated<S>; error?: undefined }
  | { ok: false; data?: undefined; error: NextResponse };

/**
 * The engine's walk, projected into this app's envelope. Every rule — which kinds
 * exist, what a wrong value is called, what `null` and an absent key mean — is in
 * `./validation-engine`, one file for all six apps. This function is here because
 * what a problem *becomes* on the wire is this app's own decision, and the six
 * have never agreed about it: five answer 400 with `{ error, fields }`, abetapi
 * answers 422 with `{ error: { code, message }, fields }` because that envelope is
 * what its published OpenAPI document promises. Reunited rules, forked answer.
 */
export function validateBody<S extends Schema>(
  body: unknown,
  schema: S,
  opts: { requireWrite?: boolean } = {},
): Validation<S> {
  const result = collectBody(body, schema, opts);
  return result.ok ? result : fail(result.problems);
}

/**
 * Parse the body of a request that is required to carry one. `request.json()`
 * throws, and a throw inside a handler is Next's 500 — measured here, so a
 * client that sends `prose`, or nothing at all, was told the server broke:
 *
 *   POST /api/lead-lists/:id?action=add-leads   (no body)      THREW SyntaxError
 *   POST /api/lead-lists/:id?action=add-leads   body "prose"   THREW SyntaxError
 *   POST /api/lead-lists/:id?action=add-leads   body []        400 leadIds required
 *
 * A value that parses is still checked by `validateBody`, which is what refuses
 * an array or a bare string. Routes whose action needs no body never call this.
 */
export async function readJson(
  request: Request,
): Promise<{ ok: true; body: unknown; error?: undefined } | { ok: false; body?: undefined; error: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: bad("request body is not valid JSON") };
  }
  return { ok: true, body };
}

/**
 * Guard a nested array of objects — `stepsConfig[]` — with the same
 * declared-field rule, so a bad entry names its index instead of arriving as
 * "the 400 that says nothing about which step".
 */
export function validateItems<T>(
  value: unknown,
  name: string,
  item: Schema,
  opts: { required?: boolean; min?: number; max?: number } = {},
): { ok: true; items: T[]; error?: undefined } | { ok: false; items?: undefined; error: NextResponse } {
  if (value === undefined) {
    if (opts.required) return { ok: false, error: bad(`${name} is required`) };
    return { ok: true, items: [] };
  }
  if (!Array.isArray(value)) return { ok: false, error: bad(`${name} must be an array, got ${describe(value)}`) };
  const max = opts.max ?? 100;
  if (value.length > max) return { ok: false, error: bad(`${name} holds ${value.length} entries; at most ${max}`) };
  if (opts.min !== undefined && value.length < opts.min) {
    return { ok: false, error: bad(`${name} must hold at least ${opts.min} entries`) };
  }
  const items: Record<string, unknown>[] = [];
  const problems: ValidationProblem[] = [];
  for (const [i, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push([`${name}[${i}]`, `${name}[${i}] must be an object, got ${describe(entry)}`]);
      continue;
    }
    const out: Record<string, unknown> = {};
    problems.push(...collect(entry as Record<string, unknown>, item, out, `${name}[${i}]`));
    items.push(out);
  }
  if (problems.length) return { ok: false, error: fail(problems).error };
  return { ok: true, items: items as T[] };
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * An array of non-empty strings: trimmed, de-duplicated, order preserved. This
 * is the rule `src/lib/ids.ts` has been running for `listIds` and `leadIds`, and
 * the one the three array columns on Lead (`technologies`, `intentSignals`,
 * `tags`) and `EnrichmentRule.providers` need for the same reason — a scalar in
 * any of them is not a bad-looking row, it is a crash or a nonsense result in
 * whatever reads it next (`dedupe.ts` spreads the first three; the exporter
 * iterates `fields`). Absent and null both mean "nothing named", so a create
 * that never mentions tags still gets the empty array its column needs.
 */
export function stringList(
  value: unknown,
  name: string,
  opts: { max?: number } = {},
): { ok: true; values: string[]; error?: undefined } | { ok: false; values?: undefined; error: NextResponse } {
  if (value === undefined || value === null) return { ok: true, values: [] };
  const parsed = parseStringList(value, name, opts.max ?? DEFAULT_LIST_MAX);
  return "values" in parsed ? { ok: true, values: parsed.values } : { ok: false, error: bad(parsed.message) };
}

/**
 * Comma-separated token list, for the column whose schema comment shows an
 * array while the only code that reads it splits on commas (`Webhook.events`).
 * Both shapes are accepted at the boundary and one shape is stored, so a
 * caller following the comment no longer gets a 500 and the reader still finds
 * what it expects.
 */
export function eventNames(
  value: unknown,
  name = "events",
  max = 50,
): { ok: true; values: string[]; error?: undefined } | { ok: false; values?: undefined; error: NextResponse } {
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { ok: false, error: bad(`${name} holds ${describe(entry)}; every event must be text`) };
      }
      parts.push(entry);
    }
  } else if (typeof value === "string") {
    parts.push(...value.split(","));
  } else {
    return {
      ok: false,
      error: bad(`${name} must be an array of event names or a comma-separated string, got ${describe(value)}`),
    };
  }
  const values: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!token) continue;
    if (!EVENT_NAME.test(token)) {
      return { ok: false, error: bad(`${name} holds ${short(token)}; an event name is letters, digits, dot, dash or underscore`) };
    }
    if (!values.includes(token)) values.push(token);
  }
  if (!values.length) return { ok: false, error: bad(`${name} must name at least one event`) };
  if (values.length > max) return { ok: false, error: bad(`${name} names ${values.length} events; at most ${max}`) };
  return { ok: true, values };
}

/* ---------- the per-field walk, shared by body and array entry ---------- */

function parseStringList(
  value: unknown,
  name: string,
  max: number,
  allowed?: readonly string[],
): { values: string[] } | { message: string } {
  if (!Array.isArray(value)) return { message: `${name} must be an array of strings` };
  if (value.length > max) return { message: `${name} holds ${value.length} entries; at most ${max}` };
  const values: string[] = [];
  for (const entry of value) {
    const item = typeof entry === "string" ? entry.trim() : entry;
    if (typeof item !== "string" || item === "") return { message: `every ${name} entry must be a non-empty string` };
    if (allowed && !allowed.includes(item)) {
      return { message: `${name} holds ${short(item)}; every entry must be one of ${allowed.join(" | ")}` };
    }
    if (!values.includes(item)) values.push(item);
  }
  return { values };
}

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * One message per field, plus a `fields` object keyed the same way as the body
 * the caller sent. The key is the point: the 500s above named an argument only
 * inside a Prisma stack line that never reached the client.
 */
function fail(problems: ValidationProblem[]): { ok: false; error: NextResponse } {
  const fields: Record<string, string> = {};
  for (const [name, message] of problems) fields[name] = message;
  return {
    ok: false,
    error: NextResponse.json({ error: problems.map(([, message]) => message).join("; "), fields }, { status: 400 }),
  };
}
