// #67 — `GET /api/leads?email=` answers the question with the whole crowd.
//
// Measured on the running app before any of this shipped, in this round's own
// runtime (`e3fcc16` built in a fresh worktree, served on :3419 over database
// `leadworks_r68`, log `/tmp/opencode/r68_press_base.log`): workspace A seeded
// with `bob@x.com`, `john@x.com`, `JOHN@X.COM` and `nina@x.com` (nina left at
// ENRICHED by a PATCH, the other three at NEW), workspace B holding its own
// `john@x.com`. The base table, verbatim:
//
//   1  ?email=john@x.com                    200 total=4  — the whole crowd
//   2  ?email=JOHN@X.COM                    200 total=4  — the whole crowd
//   3  ?email=nobody@x.com                  200 total=4  — indistinguishable from no filter
//   4  ?email=not-an-address                200 total=4  — a shape POST /api/leads refuses
//   5  ?email=                              200 total=4
//   6  ?email=john@x.com&email=nina@x.com   200 total=4
//   7  ?email=%20john@x.com%20              200 total=4
//   8  ?email=a@b..c                        200 total=4  — the shape the write door refuses
//   9  tenant B ?email=john@x.com           200 total=1  — the door was never un-scoped
//  10  ?email=john@x.com&status=NEW         200 total=3
//  11  ?email=john@x.com&status=ENRICHED    200 total=1 emails=['nina@x.com']
//  12  ?email=john@x.com&fields=email       200 total=4
//  13  ?email=john@x.com&limit=1&page=2     200 total=4 page=1 emails=['john@x.com']
//  14  ?phone=+1-555-0100                   200 total=4
//  15  ?company=x                           200 total=4
//
// Leg 11 is the one that makes this a lie rather than a gap: `status` IS read
// (#57), so the door applied half of the question and handed back a row whose
// email is not the email that was asked for. Legs 3 and 5 say the same thing
// together — `total=4` for an address nobody holds is the same body as `total=4`
// for no filter at all, so "nobody by that name" and "you did not ask" are one
// answer.
//
// The fix's own legs, on the shipped build over the same rows
// (`/tmp/opencode/r68_press_fix.log`):
//
//   1  ?email=john@x.com                    200 total=1 emails=['john@x.com']
//   2  ?email=JOHN@X.COM                    200 total=1 emails=['JOHN@X.COM']
//   3  ?email=nobody@x.com                  200 total=0
//   4  ?email=not-an-address                400 — the create door's sentence, byte for byte
//   8  ?email=a@b..c                        400 — same
//  11  ?email=john@x.com&status=ENRICHED    200 total=0
//  13  ?email=john@x.com&limit=1&page=2     200 total=1 — paged past the filtered crowd
//
// The rule the file pins is the one the write door already runs: the value is
// judged by `LEAD_EMAIL`, the entry `LEAD_CREATE.email` itself, so this app has
// one email rule rather than one for a body and one for a query string. The match
// is byte-exact, and that is written down as a limit rather than smoothed over:
// folding belongs to #99, and a `mode: "insensitive"` filter here would stop the
// composite `@@unique([workspaceId, email])` from being used.
//
// Nothing here needs a browser, a database or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { LEAD_CREATE, LEAD_EMAIL } from "../../src/lib/fields";
import { filterParam, textFilterParam } from "../../src/lib/list-filter";
import { validateBody } from "../../src/lib/validate";
import type { Field } from "../../src/lib/validation-engine";
import { openapiOperations } from "../../src/lib/openapi";
import { LEAD_STATUSES } from "../../src/lib/enums";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(join(srcDir, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = join(srcDir, dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(join(dir, entry.name));
  });

const leadsDoor = at("../../src/app/api/leads/route.ts");
const filterLib = blankComments(at("../../src/lib/list-filter.ts"));
const fieldsLib = blankComments(at("../../src/lib/fields.ts"));
const schema = at("../../prisma/schema.prisma");
const GET_body = blankComments(functionBody(leadsDoor, "GET_impl") ?? "");

/**
 * Ask the door's filter the way the route does. Pairs rather than a query string:
 * `URLSearchParams` decodes `+` as a space, and an address with a plus in it is a
 * real address that must not arrive here pre-mangled.
 */
const asked = (params: [string, string][], name = "email", field: Field = LEAD_EMAIL) =>
  textFilterParam(new URLSearchParams(params), name, field);

/** The refusal's own body, read the way the caller would read it. */
async function refusal(result: ReturnType<typeof textFilterParam>, what = "the filter") {
  assert.ok(result.error, `${what} was expected to refuse`);
  return { status: result.error.status, json: (await result.error.json()) as Record<string, unknown> };
}

/** An address exactly `total` characters long, of the shape the column accepts. */
const address = (total: number) => `${"a".repeat(total - 102)}@${"b".repeat(50)}.${"c".repeat(50)}`;

test("every address the column can hold is a value the filter takes", () => {
  for (const one of ["bob@x.com", "JOHN@X.COM", "a@b.co", "first.last+tag@sub.example.gov.uk"]) {
    const result = asked([["email", one]]);
    assert.equal(result.value, one, `?email=${one} filters for ${one}`);
    assert.equal(result.error, null);
  }
});

test("the value reaches the filter with its bytes, not a folded copy of them", () => {
  // `?email=JOHN@X.COM` asks for those bytes. Folding is #99's decision to make at
  // the write doors, and a read door that folded first would answer a question the
  // caller did not ask while pretending to answer the one they did.
  assert.equal(asked([["email", "JOHN@X.COM"]]).value, "JOHN@X.COM");
  assert.equal(asked([["email", "bob@X.com"]]).value, "bob@X.com");
  assert.doesNotMatch(GET_body, /email\.value\.(toLowerCase|toUpperCase)\(/, "the door does not fold it either");
  assert.doesNotMatch(GET_body, /email\s*=\s*\{[^}]*insensitive[\s\S]*/, "nor does it ask Prisma to");
  assert.match(schema, /@@unique\(\[workspaceId, email\]\)/, "and the index it matches is the byte-exact one");
});

test("the padding is not part of the address", () => {
  for (const padded of [" john@x.com", "john@x.com ", "\tjohn@x.com\t"]) {
    assert.equal(asked([["email", padded]]).value, "john@x.com", `${JSON.stringify(padded)} is the bare address`);
    assert.equal(asked([["email", padded]]).error, null);
  }
});

test("an empty value names nobody, and an absent one is the same answer", () => {
  for (const query of [[["email", ""]], [["email", " "]], [["page", "2"]]] as [string, string][][]) {
    const result = asked(query);
    assert.equal(result.value, null, `${new URLSearchParams(query).toString()} is an absent email, not a wrong one`);
    assert.equal(result.error, null);
  }
});

test("the same address twice is one address", () => {
  const result = asked([["email", "john@x.com"], ["email", "john@x.com"], ["email", " john@x.com"]]);
  assert.equal(result.value, "john@x.com");
  assert.equal(result.error, null);
});

test("two different addresses are a question with two answers, and it is refused", async () => {
  const { status, json } = await refusal(asked([["email", "john@x.com"], ["email", "nina@x.com"]]));
  assert.equal(status, 400);
  assert.equal(
    json.error,
    'email was given 2 words ("john@x.com", "nina@x.com"); this filter compares email to one of them',
    "the sentence `filterParam` already speaks for a word column",
  );
  const three = await refusal(asked([["email", "a@x.com"], ["email", "b@x.com"], ["email", "c@x.com"]]));
  assert.match(three.json.error as string, /^email was given 3 words \("a@x.com", "b@x.com", "c@x.com"\)/);
});

test("an address the write door would refuse is refused with the write door's sentence", async () => {
  // The whole design in one assertion: the read door owns no email rule, it borrows
  // the one `POST /api/leads` runs. So the two bodies are compared, not eyeballed.
  for (const junk of ["not-an-address", "a@b", "a@b..c", " spaced @x.com", "a,b@x.com", "plain text"]) {
    const here = await refusal(asked([["email", junk]]));
    const there = validateBody({ email: junk }, LEAD_CREATE);
    if (there.ok) throw new Error(`the create door accepted ${JSON.stringify(junk)}, so this comparison means nothing`);
    assert.deepEqual(
      here.json,
      (await there.error.json()) as Record<string, unknown>,
      `?email=${JSON.stringify(junk)} and {"email":${JSON.stringify(junk)}} get one answer, not two`,
    );
    assert.equal(here.status, 400);
  }
});

test("the column's own length cap is the filter's length cap", async () => {
  // `LEAD_CREATE.email.max`, enforced here too rather than left to a `where` that
  // compares five thousand characters to a column that can never hold them.
  assert.equal(LEAD_EMAIL.max, 254);
  assert.equal(address(254).length, 254);
  assert.equal(asked([["email", address(254)]]).value, address(254));
  const { json } = await refusal(asked([["email", address(255)]]));
  assert.equal(json.error, "email is 255 characters; at most 254");
});

test("the field the read door judges by is the field the write door validates by", () => {
  // Not a copy of the same rules — the same object. A future door that filters on
  // another text column passes that column's own entry, and nothing in
  // `list-filter.ts` knows what `email` means.
  assert.equal(LEAD_EMAIL, LEAD_CREATE.email, "one entry, named once");
  assert.deepEqual(
    { kind: LEAD_EMAIL.kind, format: LEAD_EMAIL.format, max: LEAD_EMAIL.max, nullable: LEAD_EMAIL.nullable },
    { kind: "text", format: "email", max: 254, nullable: true },
  );
  assert.match(schema, /^\s{2}email\s+String\?$/m, "the column this judges is the nullable String the schema declares");
  assert.match(fieldsLib, /export const LEAD_EMAIL: Field = LEAD_CREATE\.email/);
});

test("a text column that is not an address is judged by its own field", async () => {
  // `phone` has no `format`, so the shape refusal above must not follow the name
  // `email` into this file: the judge travels with the column, not with the key.
  const phone: Field = LEAD_CREATE.phone;
  assert.equal(phone.format, undefined);
  assert.equal(asked([["phone", "+1-555-0100"]], "phone", phone).value, "+1-555-0100");
  const { json } = await refusal(asked([["phone", "9".repeat(33)]], "phone", phone), "the phone filter");
  assert.equal(json.error, "phone is 33 characters; at most 32");
  assert.doesNotMatch(filterLib, /email/i, "the module never names the column it is judging");
  assert.doesNotMatch(filterLib, /EMAIL|insensitive|@/, "and holds no address rule of its own");
});

test("GET /api/leads reads email through the shared judge and puts the result in the where", () => {
  assert.match(GET_body, /textFilterParam\(searchParams,\s*"email",\s*LEAD_EMAIL\)/);
  assert.match(GET_body, /if \(email\.error\) return email\.error/);
  assert.match(GET_body, /if \(email\.value\) where\.email = email\.value/);
  assert.doesNotMatch(GET_body, /searchParams\.get\("email"\)/, "the raw parameter is not read any more");
  assert.match(
    leadsDoor,
    /import \{ LEAD_CREATE, LEAD_EMAIL, LEAD_FIELD_PICK/,
    "the door imports the entry rather than re-typing a field table",
  );
});

test("the refusal runs before anything is fetched", () => {
  const refuse = GET_body.indexOf("if (email.error) return email.error");
  const fetch = GET_body.indexOf("prisma.lead.findMany");
  assert.ok(refuse >= 0 && fetch >= 0, "both calls are in the handler");
  assert.ok(refuse < fetch, "a bad address costs no query");
});

test("the same where answers the page and the total", () => {
  // `total` is the pagination's own claim: were the count run against a different
  // `where` than the rows, a filtered page of one would still report the whole
  // crowd and leg 13 (`limit=1&page=2`) would read as "there is more coming".
  assert.match(GET_body, /const pageWindow = \{ where,/);
  assert.match(GET_body, /prisma\.lead\.count\(\{ where \}\)/);
  assert.ok(
    GET_body.indexOf("where.email = email.value") < GET_body.indexOf("const pageWindow"),
    "the filter is in the where before the where is used",
  );
});

test("the door is still scoped to the workspace the key names", () => {
  // Measured before the fix too (leg 9: tenant B answered its own one row), and it
  // stays pinned because a new filter is exactly where a scope leak hides: the
  // `where` starts from `workspaceId` and `email` is added to it, never instead.
  assert.match(GET_body, /const where: any = \{ workspaceId \}/);
  assert.match(GET_body, /authedWorkspaceId\(request, searchParams\.get\("workspaceId"\)\)/);
});

test("no read door anywhere takes a column out of the query string raw", () => {
  // The census that keeps a fifth hole from opening. `workspaceId` is the caller's
  // own scope and is settled by the auth layer; `action` is a dispatch word with a
  // refusal of its own; `model` and `id` are named because those two doors read
  // them straight today. Everything else has to go through a judge — `filterParam`
  // for a word, `textFilterParam` for text, `idFilterParam` for an id, `intParam`
  // and `pageParams` for a number, `fieldsParam` for a projection.
  const allowed = new Set(["workspaceId", "action", "model", "id"]);
  const offenders: string[] = [];
  for (const file of srcFiles("app/api")) {
    const code = blankComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(/searchParams\.(?:get|getAll)\("([^"]+)"\)/g)) {
      if (!allowed.has(match[1])) {
        offenders.push(`${file.slice(srcDir.length)} — reads ${match[1]} raw`);
      }
    }
  }
  assert.deepEqual(offenders, [], `query-string names with no rule in front of them:\n  ${offenders.join("\n  ")}`);
});

test("?phone= and ?company= are still not filters, and this says so rather than fixing it quietly", () => {
  // Legs 14 and 15: both answered the whole crowd on the base build and both still
  // do. `email` is the column #66's 409 names and the one the unique index
  // promises, so it is the one that ships; the rest is a decision about a wider
  // filter surface and belongs in front of whoever owns this door's contract.
  assert.doesNotMatch(GET_body, /textFilterParam\(searchParams,\s*"(phone|company)"/);
  const described = (openapiOperations.find((entry) => entry.operation.id === "leads.list")!.operation.query ?? []).map(
    ([name]) => name,
  );
  assert.deepEqual(
    described.filter((name) => name === "phone" || name === "company"),
    [],
    "the contract does not advertise a filter the door does not read",
  );
});

test("the contract advertises ?email=, names who judges it, and prices the wrong shape", () => {
  const door = openapiOperations.find((entry) => entry.operation.id === "leads.list")!;
  const described = (door.operation.query ?? []).find(([name]) => name === "email");
  assert.ok(described, "leads.list documents `email`");
  assert.ok(described[1].includes("POST /api/leads"), "and names the door whose rule it shares");
  assert.ok(described[1].includes("exact"), "and says the match is byte-exact, not folded");
  assert.ok((door.operation.responses ?? {})["400"].includes("`email`"), "and prices a wrong one");
  assert.deepEqual(
    (door.operation.query ?? []).map(([name]) => name),
    ["workspaceId", "listId", "status", "email", "page", "limit", "fields"],
    "every parameter the door reads is documented, and nothing it does not read is",
  );
});

test("adding a text filter left the word filter alone", () => {
  // #57's pins live in `list-filter.test.ts`; this is the cheap promise that the
  // two judges still sit side by side in the same door, each on its own column,
  // and that a word column is not being run through the text judge.
  assert.match(GET_body, /filterParam\(searchParams,\s*"status",\s*LEAD_STATUSES\)/);
  assert.match(GET_body, /where\.status = status\.value/);
  const word = filterParam(new URLSearchParams([["status", "qualified"]]), "status", LEAD_STATUSES);
  assert.equal(word.value, null, "a word the column does not hold is still refused");
  const text = textFilterParam(new URLSearchParams([["status", "qualified"]]), "status", {
    kind: "enum",
    values: LEAD_STATUSES,
  });
  assert.equal(text.value, null, "and the text judge refuses it too, because it defers to the field it is given");
});
