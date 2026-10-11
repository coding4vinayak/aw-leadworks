// N5, held in place: a request body that reaches Prisma unvalidated is a 500 or
// a wrong row, and there is nothing in the type system that notices when the
// next route forgets.
//
// Measured against this app's own dev.db, through the exported handlers, before
// the field tables existed:
//
//   POST /api/sources            config absent      500 "Argument `config` is missing"
//   POST /api/leads              email: 42          500 PrismaClientValidationError
//   POST /api/leads              customFields: 42   201, a number in a Json column
//   PATCH /api/leads/:id         score: 9999        200, and that lead now sorts
//                                                  first for every reader
//   PATCH /api/leads/:id         {}                 200 holding an unchanged row
//   PATCH /api/sources/:id       type: "NOT_A_TYPE" 200, invisible to every filter
//   POST /api/lead-lists         isDynamic: "no"    201, isDynamic true
//   POST /api/jobs               sourceId: "nope"   500 P2003
//   POST /api/exports            fields: ["nope"]   201, a blank column in the file
//   PATCH /api/webhooks/:id      isActive: "no"     200, a disabled hook enabled
//
// All ten are 400s now, with the field named. What this file pins is that they
// stay that way: `validate.test.ts` proves the engine, and these prove that
// every route is actually plugged into it. The scanner is shared with
// `route-auth.test.ts` for the reason given there — a copy scanned twice drifts
// twice, and a handler either copy cannot see has to fail, not pass quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectHandlers, countCodeMentions, schemaArgs, unresolvedTailCalls } from "./route-handlers";
import * as FIELDS from "../../src/lib/fields";
import * as ENUMS from "../../src/lib/enums";

/** The calls that decide what a body may contain. */
const VALIDATES = /validateBody\s*\(|validateItems\s*\(|eventNames\s*\(|asStrings\s*\(/;

/** Whether a handler reads the caller's JSON at all, however it gets it. */
const READS_A_BODY = /readJson\s*\(|\brequest\.json\s*\(\s*\)/;

/**
 * Handlers that read a body and are not on the list above, each with the reason
 * it is acceptable. Adding a line here is the review step, same as PUBLIC is for
 * authentication.
 *
 * These two were invisible until the rule looked for `request.json()` as well as
 * `readJson()`: they read a body, and a rule that only matches the helper it
 * likes cannot see a handler that does not use it. Neither writes a Prisma row.
 * `checkout` is session-authed, and `priceId` is refused unless it is one of this
 * plan's own prices; `portal`'s `returnUrl` goes through `sameOriginReturnUrl`,
 * which is a same-origin test rather than a field shape, so it has no kind here.
 * Both `catch` a non-JSON body into a 400 rather than a 500.
 */
const UNVALIDATED: Record<string, string[]> = {
  "src/app/api/billing/checkout/route.ts": ["POST"],
  "src/app/api/billing/portal/route.ts": ["POST"],
};

test("every handler that reads a body validates it", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if (!READS_A_BODY.test(h.body)) continue;
    if (VALIDATES.test(h.body)) continue;
    if ((UNVALIDATED[h.file] ?? []).includes(h.method)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers that read a body and hand it to Prisma unchecked:\n  ${offenders.join("\n  ")}`);
});

test("UNVALIDATED names handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale = Object.entries(UNVALIDATED).flatMap(([file, methods]) => methods.filter((m) => !seen.has(`${file} ${m}`)));
  assert.deepEqual(stale, [], `excused but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});

// The routes' source, not the handlers' resolved bodies: an import is outside
// the body, and the schema argument is read out of the call where it is used.
const ROUTE_FILES = [...new Set(collectHandlers().map((h) => h.file))];
const routeSource = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("a route validates against a declared table, never an inline one", () => {
  const declared = new Set(Object.keys(FIELDS));
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    for (const arg of schemaArgs(routeSource(file))) {
      if (arg.startsWith("{")) offenders.push(`${file} — an inline schema`);
      else if (!declared.has(arg)) offenders.push(`${file} — ${arg} is not exported from lib/fields`);
    }
  }
  assert.deepEqual(offenders, [], `validate calls with no table in lib/fields:\n  ${offenders.join("\n  ")}`);
});

test("every declared table is used by a route, and every enum set by a table", () => {
  // `LEAD_EXPORT_FIELDS` is a value list another table reads (`fields: { values:
  // LEAD_EXPORT_FIELDS }`), so it is used from inside fields.ts rather than from
  // a route. Either counts; nothing counts by being mentioned in a comment.
  const fieldSource = routeSource("src/lib/fields.ts");
  const unusedTables = Object.keys(FIELDS).filter(
    (name) => !ROUTE_FILES.some((file) => new RegExp(`\\b${name}\\b`).test(routeSource(file)))
      && countCodeMentions(fieldSource, name) === 0,
  );
  assert.deepEqual(unusedTables, [], `tables in lib/fields nothing uses — delete them or wire them:\n  ${unusedTables.join("\n  ")}`);

  const unusedEnums = Object.keys(ENUMS).filter((name) => countCodeMentions(fieldSource, name) === 0);
  assert.deepEqual(unusedEnums, [], `enum sets no field table checks against:\n  ${unusedEnums.join("\n  ")}`);
});

/**
 * A text field called `somethingId` names a row rather than filling a column, so
 * the type check is only half the rule: measured, `sourceId: "nope"` was a valid
 * string and still came back as a bare P2003. The route has to say whether the id
 * exists and belongs to this workspace, either through the batch helpers (a list
 * of ids answers 422 naming the ones it did not find) or through a lookup that
 * 404s (a single id, where "no such row" is the whole answer).
 */
test("an id-typed field is checked for existence where it is accepted", () => {
  const offenders: string[] = [];
  for (const [name, schema] of Object.entries(FIELDS)) {
    const idFields = Object.entries(schema as Record<string, { kind?: string }>)
      .filter(([field, spec]) => /Id$/.test(field) && spec?.kind === "text")
      .map(([field]) => field);
    if (!idFields.length) continue;
    for (const file of ROUTE_FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(routeSource(f)))) {
      const src = routeSource(file);
      for (const field of idFields) {
        const batchChecked = new RegExp(`(unknownIdError|unknownIdsError|missingIds)[^)]*\\b${field}\\b`).test(src);
        const lookedUp = new RegExp(`where:\\s*\\{[^}]*\\bid:\\s*${field}\\b`).test(src);
        if (!batchChecked && !lookedUp) {
          offenders.push(`${file} accepts ${name}.${field} without checking the row exists`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `foreign keys taken on faith:\n  ${offenders.join("\n  ")}`);
});

/**
 * A handler whose body is `return helper(request)` validates nothing and writes nothing
 * until the helper is read. The scanner resolves same-file tail calls (§8.41); this asks
 * it, once per handler, whether the callee's block actually came back — so the day the
 * resolution breaks, the rules above fail loudly instead of passing on a thinner body.
 * Vendored mechanism, local assertion: 181 handlers across the six apps, none hidden.
 */
test("no handler hides a same-file helper behind a tail call", () => {
  const hidden = unresolvedTailCalls(collectHandlers());
  assert.deepEqual(hidden, [], `scanned without the function they return:\n  ${hidden.join("\n  ")}`);
});
