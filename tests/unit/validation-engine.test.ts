/**
 * The engine's answer, pinned once for six apps.
 *
 * Vendored by `shared/sync-validation.sh` into every app's `tests/unit/`, next to
 * the guard that insists it stays byte-identical and keeps importing
 * `../../src/lib/validation-engine`. The reason it has to be in all six rather than
 * in `shared/` is the reason the engine is: `npm test` runs inside an app, against
 * that app's own `node_modules`, and a suite that reads one app's copy of a shared
 * rule proves nothing about the other five. Run from any app, this file asserts the
 * same table against that app's engine — so six green suites now *means* six apps
 * that cannot answer a wrong value differently.
 *
 * What is pinned, in order: one sentence per kind, verbatim, which is the part that
 * had drifted into six wordings of the same refusal; the article that agrees with
 * the noun, which is the bug this round started on; the ceiling an `int` has whether
 * or not the table gave it one; a list of names being a set, and a wrong element
 * named by index; the three different answers blank, `null` and absent must give;
 * and the `default` arm, which is the one assertion here that a future edit is most
 * likely to break — a table that names a kind the collector has not implemented used
 * to *drop that field quietly*, and this file is what stops that from coming back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, collectBody, DEFAULT_LIST_MAX, NO_FIELD_TO_UPDATE, type Schema } from "../../src/lib/validation-engine";

/** The problems a body produces, or none when the engine accepted it. */
function problems(body: unknown, schema: Schema, opts: { requireWrite?: boolean } = {}): string[] {
  const result = collectBody(body, schema, opts);
  return result.ok ? [] : result.problems.map(([, message]) => message);
}

function first(body: unknown, schema: Schema): string {
  const found = problems(body, schema);
  assert.equal(found.length, 1, `expected exactly one problem for ${JSON.stringify(body)}, got ${found.length}: ${found.join(" | ")}`);
  return found[0];
}

const ONE = { v: { kind: "text", required: true } } satisfies Schema;

test("one wrong value per kind, and the engine's sentence is one sentence", () => {
  // This table is the reunification. Six `collect` copies agreed about which values
  // are wrong and disagreed about what to say, so the wording is asserted here at
  // full length — a fragment match would let "got a object" pass beside "got an
  // object", which is precisely the difference this round exists to close.
  const CASES: Array<[Schema, unknown, string]> = [
    [{ v: { kind: "text" } }, 42, "v must be text, got a number"],
    [{ v: { kind: "int" } }, "5", 'v must be a whole number, got "5" as text — send it unquoted'],
    [{ v: { kind: "int" } }, 1.9, "v must be a whole number, got a number — send it without a fraction"],
    [{ v: { kind: "number" } }, "5", 'v must be a finite number, got "5" as text — send it unquoted'],
    [{ v: { kind: "bool" } }, "no", "v must be true or false, got a string — send it unquoted"],
    [{ v: { kind: "date" } }, 42, "v must be an ISO 8601 date string, got a number"],
    [{ v: { kind: "date" } }, "garbage", 'v is not a date: "garbage"'],
    [{ v: { kind: "enum", values: ["EMAIL", "WHATSAPP"] } }, "FAX", 'v must be one of EMAIL | WHATSAPP, got "FAX"'],
    [{ v: { kind: "enum", values: ["A"] } }, 42, "v must be one of A, got a number"],
    [{ v: { kind: "strings" } }, "a,b", "v must be an array of strings, got a string — send it as a one-element array"],
    [{ v: { kind: "json" } }, 42, "v must be an object or an array, got a number"],
    [{ v: { kind: "json", objectOnly: true } }, [], "v must be an object, got an array"],
  ];
  for (const [schema, value, expected] of CASES) {
    assert.equal(first({ v: value }, schema), expected);
  }
});

test("an unimplemented kind is refused, never dropped", () => {
  // A `switch` over `field.kind` with no `default` arm answers a kind it has never
  // heard of by leaving the field out of `out` — no write, no problem, a 201 for a
  // caller whose value went nowhere. That is the failure the six separate collectors
  // each allowed on their own, and the only way to keep it from coming back is to
  // ask for it with a kind that does not exist.
  const schema = { v: { kind: "money" } } as unknown as Schema;
  assert.deepEqual(problems({ v: 42 }, schema), ["v declares a kind no engine implements: money"]);
  // …and the value is not silently handed to the route either.
  assert.equal(collectBody({ v: 42 }, schema).ok, false);
});

test("the article agrees with the noun, in every shape a body can hold", () => {
  // `typeof null` is "object" and `typeof []` is "object", so a copy that interpolates
  // `typeof` after the article "a" produces "a object" — the sentence three of the
  // six apps were answering their callers with, and the one no test quoted because
  // no test had read it.
  assert.equal(first({ v: {} }, { v: { kind: "text" } }), "v must be text, got an object");
  assert.equal(first({ v: [1] }, { v: { kind: "text" } }), "v must be text, got an array");
  assert.equal(first({ v: true }, { v: { kind: "text" } }), "v must be text, got a boolean");
  assert.equal(first({ v: 42 }, { v: { kind: "text" } }), "v must be text, got a number");
});

test("an int has a ceiling whether or not the table gave it one", () => {
  // Measured in abetapi: `rateLimitPerMin: 1e21` is a whole number, passes
  // `Number.isInteger`, and Prisma's answer was a 500 from an `Int` overflow.
  assert.equal(first({ v: 1e21 }, { v: { kind: "int" } }), "v must be at most 9007199254740991");
  // A `number` has no such ceiling to have — a Float column can hold it — so an
  // undeclared max must not invent one.
  assert.equal(problems({ v: 1e21 }, { v: { kind: "number" } }).length, 0);
  // Declared bounds still win, in both directions.
  assert.equal(first({ v: 100 }, { v: { kind: "int", max: 60 } }), "v must be at most 60");
  assert.equal(first({ v: 5 }, { v: { kind: "int", min: 10 } }), "v must be at least 10");
});

test("a list of names is a set, and a wrong element is named by index", () => {
  const tags = { v: { kind: "strings" } } satisfies Schema;
  // Trimming and de-duplicating remove nothing the caller asked for: `["b", " b "]`
  // is one tag. Refusing a value the caller did ask for and the column cannot use is
  // a different act, and is what `values` and `itemMax` are for.
  assert.deepEqual(collectBody({ v: [" b ", "a", "b"] }, tags).data?.v, ["b", "a"]);
  assert.equal(first({ v: ["ok", 42] }, tags), 'v[1] must be text, got a number');
  assert.equal(first({ v: ["ok", "  "] }, tags), "v[1] must be a non-empty string");
  assert.equal(first({ v: ["ok", "x".repeat(9)] }, { v: { kind: "strings", itemMax: 8 } }), "v[1] is 9 characters; at most 8");
  assert.equal(
    first({ v: ["email", "nope"] }, { v: { kind: "strings", values: ["email", "score"] } }),
    'v[1] must be one of email | score, got "nope"',
  );
  const many = Array.from({ length: DEFAULT_LIST_MAX + 1 }, (_, i) => `t${i}`);
  assert.equal(first({ v: many }, tags), `v holds ${DEFAULT_LIST_MAX + 1} entries; at most ${DEFAULT_LIST_MAX}`);
  // The singular is part of the sentence a caller reads.
  assert.equal(first({ v: [] }, { v: { kind: "strings", min: 1 } }), "v must hold at least one entry");
  assert.equal(first({ v: [] }, { v: { kind: "strings", min: 2 } }), "v must hold at least 2 entries");
});

test("blank, null and absent are three different answers", () => {
  // Blank is what a form posts for "I cleared this", `null` is what a caller sends
  // for "no value", and absent means "not mentioned" — a PATCH that treated the last
  // two alike would reset a column the caller never named.
  assert.deepEqual(collectBody({ v: "  " }, ONE).data?.v, undefined);
  assert.equal(first({ v: "  " }, ONE), "v must be a non-empty string");
  assert.equal(first({ v: null }, ONE), "v is required and cannot be null");
  assert.equal(first({ v: null }, { v: { kind: "text" } }), "v cannot be null; omit it to leave the value alone");
  assert.equal(collectBody({ v: null }, { v: { kind: "text", nullable: true } }).data?.v, null);
  assert.equal(first({ v: null }, { v: { kind: "json" } }), "v cannot be null — send {} to clear it, or omit the key to leave it alone");
  assert.equal(first({}, ONE), "v is required");
  assert.equal("v" in (collectBody({}, { v: { kind: "text" } }).data ?? {}), false);
});

test("a date becomes a Date at the engine's own epoch, and a blank one clears", () => {
  const schema = { v: { kind: "date" } } satisfies Schema;
  const offset = collectBody({ v: "2026-01-05T10:00:00+08:00" }, schema).data?.v;
  assert.ok(offset instanceof Date);
  assert.equal((offset as Date).toISOString(), "2026-01-05T02:00:00.000Z");
  assert.equal(first({ v: "" }, schema), "v must be a date, not blank");
  assert.equal(collectBody({ v: "" }, { v: { kind: "date", nullable: true } }).data?.v, null);
});

test("a body that is not an object, and a PATCH that changes nothing", () => {
  assert.deepEqual(problems("prose", ONE), ["request body must be a JSON object, got a string"]);
  assert.deepEqual(problems([], ONE), ["request body must be a JSON object, got an array"]);
  assert.deepEqual(problems(null, ONE), ["request body must be a JSON object, got null"]);
  assert.deepEqual(problems({ name: "x" }, {}, { requireWrite: true }), [NO_FIELD_TO_UPDATE]);
  // A required field is answered first: telling somebody their empty update changed
  // nothing, when they also forgot the one field they had to send, is the wrong tip.
  assert.deepEqual(problems({}, ONE, { requireWrite: true }), ["v is required"]);
});

test("the address and the pattern rules belong to the engine, not to one app", () => {
  // `new URL` alone accepts `javascript:` and `file:`, which is exactly what a webhook
  // signer would then POST to.
  const url = { v: { kind: "text", format: "url" } } satisfies Schema;
  assert.equal(problems({ v: "https://hooks.test/a" }, url).length, 0);
  assert.equal(first({ v: "javascript:alert(1)" }, url), 'v must be an http(s) URL, got "javascript:alert(1)"');
  assert.equal(first({ v: "http://" }, url), 'v must be an http(s) URL, got "http://"');
  const email = { v: { kind: "text", format: "email" } } satisfies Schema;
  assert.equal(problems({ v: "a@b.co" }, email).length, 0);
  assert.equal(first({ v: "a@b" }, email), 'v does not look like an email address: "a@b"');
  // A pattern says what it wants in its own words, because the table is where the
  // route wrote them.
  assert.equal(
    first({ v: "ABC" }, { v: { kind: "text", pattern: /^[a-z]+$/ } }),
    'v does not match ^[a-z]+$: "ABC"',
  );
  // Length is answered before shape: a 5,000-character "URL" is too long first, and
  // echoing forty characters of it answers the wrong question.
  assert.equal(first({ v: "x".repeat(501) }, { v: { kind: "text", format: "url" } }), "v is 501 characters; at most 500");
});

test("every field's problem is reported at once, keyed where the caller put it", () => {
  const schema = { a: { kind: "text", required: true }, b: { kind: "int", required: true } } satisfies Schema;
  const result = collectBody({ a: 1, b: "2" }, schema);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems?.map(([key]) => key), ["a", "b"]);

  // A nested walk is the same engine with a location: `steps[0].name` is the key the
  // caller's own body has, and the label says where the message came from.
  const out: Record<string, unknown> = {};
  const found = collect({ steps: [{ name: 42 }] }, { steps: { kind: "json" } }, out, "");
  assert.deepEqual(found, []);
  const nested: Record<string, unknown> = {};
  const at = collect({ name: 42 }, { name: { kind: "text" } }, nested, "steps[0]");
  assert.deepEqual(at, [["steps[0].name", "steps[0] name must be text, got a number"]]);
});
