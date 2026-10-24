// #47: `GET /api/leads` did not read `fields`, even though the sibling door two
// routes away started obeying it in #46. Measured against the running app on this
// round's base build (a crowd of 300 imported leads, 100 of them on one list;
// /tmp/opencode/r47_probe_after.mjs run against :3313 holds the base-build run and
// against :3314 the fixed one):
//
//   ?limit=50                              -> 200, 93,129 bytes, 35 keys per row
//   ?limit=50&fields=email,score,status    -> 200, 93,129 bytes, 35 keys
//   ?limit=50&fields=email                 -> 200, 93,129 bytes, 35 keys
//   ?limit=50&fields=nonsense              -> 200, 93,129 bytes — a 200, not a refusal
//   ?limit=50&select=email                 -> 200, 93,129 bytes
//
// Eleven spellings of "give me less than the row", and all eleven cost 93,129 bytes.
// On the fix the same door over the same database answers `?fields=email,score,status`
// with 3,293 bytes — 28.4× less, one column being 1,966 — because `scoreBreakdown`,
// the nested `listMemberships` and `_count` are a column and two joins this caller
// never named. The unprojected page is 93,517 there against 93,129 here, and the
// difference is this door's tiebreaker-free order putting different tied rows on the
// page, not a projection that leaks into the branch that asks for none.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LEAD_EXPORT_FIELDS, LEAD_FIELD_PICK, EXPORT_CREATE } from "../../src/lib/fields";
import { fieldsParam, leadSelect } from "../../src/lib/list-fields";
import { validateBody } from "../../src/lib/validate";
import { openapiSpec } from "../../src/lib/openapi";
import { blankComments, functionBody } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const route = at("../../src/app/api/leads/route.ts");
const clean = blankComments(route);
const GET = functionBody(clean, "GET_impl") as string;

/** The door's judgement, in the order the door performs it, with the 400 read as its caller would. */
async function judge(query: string) {
  const asked = fieldsParam(new URLSearchParams(query));
  if (asked === null) return { picked: null as null | string[], refusal: null as null | { status: number; body: Record<string, unknown> } };
  const input = validateBody({ fields: asked }, LEAD_FIELD_PICK);
  if (!input.ok) {
    const error = input.error as unknown as { status: number; json(): Promise<Record<string, unknown>> };
    return { picked: null, refusal: { status: error.status, body: await error.json() } };
  }
  return { picked: input.data.fields as string[], refusal: null };
}
const message = (refusal: { body: Record<string, unknown> }) => String(refusal.body.error);

describe("the leads door reads its own fields parameter, and reads nothing else", () => {
  it("asks the shared reader rather than growing a second one", () => {
    assert.match(clean, /fieldsParam\(searchParams\)/, "the query-string half is list-fields', not a local parse");
    assert.match(clean, /leadSelect\(picked\)/, "the select is built by the same helper the list door uses");
    assert.match(route, /from "@\/lib\/list-fields"/, "imported from the module #46 wrote");
    assert.match(clean, /LEAD_FIELD_PICK/, "validated against the table the list door validates against");
    assert.equal(/values:\s*\[/.test(clean), false, "no second column list appears in the route");
  });

  it("hands Prisma a select of the named columns, and only that, when the caller named columns", () => {
    assert.match(GET, /select:\s*leadSelect\(picked\)/);
    const projected = GET.slice(GET.indexOf("picked ?"), GET.indexOf("prisma.lead.count"));
    assert.equal(projected.includes("include:"), false, "the projected branch does not ask for the joins at all");
    assert.equal(/delete\s|JSON\.parse\(JSON\.stringify/.test(clean), false, "the thinning happens in the read, not in serialization");
  });

  it("keeps the unprojected answer exactly what it was: the row, its memberships, its counts", () => {
    assert.match(GET, /listMemberships:\s*\{\s*include:\s*\{\s*list:\s*true\s*\}\s*\}/);
    assert.match(GET, /_count:\s*\{\s*select:\s*\{\s*activities:\s*true,\s*enrichmentLogs:\s*true\s*\}\s*\}/);
  });

  it("shares the filter, the order and the window between the two branches", () => {
    const window = GET.slice(GET.indexOf("const pageWindow"), GET.indexOf("const [leads, total]"));
    assert.match(window, /orderBy:\s*\{\s*score:\s*"desc"/, "a projection must not reorder the page");
    assert.match(window, /skip:\s*\(page\s*-\s*1\)\s*\*\s*limit/);
    assert.match(window, /take:\s*limit/);
    assert.match(window, /where,/, "the same filtered crowd on both branches");
  });

  it("still counts the whole filtered crowd beside the projected page, in the same round trip", () => {
    assert.match(GET, /Promise\.all\(\[[\s\S]*?prisma\.lead\.count\(\{ where \}\)/);
    assert.equal((GET.match(/prisma\.lead\.count/g) ?? []).length, 1, "one count, no second round trip");
  });

  it("names the columns it handed back only when the caller asked for them", () => {
    const tail = GET.slice(GET.indexOf("const envelope"));
    assert.match(tail, /picked\s*\?\s*\{\s*\.\.\.envelope,\s*leadFields:\s*picked\s*\}\s*:\s*envelope/);
    assert.equal(tail.includes("memberFields"), false, "the list door's word stays the list door's");
    assert.equal(tail.split("leadFields").length - 1, 1, "written once, on the projected branch");
  });

  it("leaves the door's own order untouched: the key is judged before the names are", () => {
    assert.ok(GET.indexOf("authedWorkspaceId") < GET.indexOf("fieldsParam"), "auth first, then the projection");
    assert.ok(GET.indexOf("fieldsParam") < GET.indexOf("prisma.lead.findMany"), "the names are judged before the crowd is read");
  });

  it("does not touch the write door in the same file", () => {
    const POST = functionBody(clean, "POST_impl") as string;
    assert.equal(POST.includes("fieldsParam"), false);
    assert.equal(POST.includes("leadSelect"), false);
    assert.match(POST, /validateBody\(body,\s*LEAD_CREATE\)/, "the intake door still validates the body table");
  });
});

describe("one vocabulary, three doors: the projection cannot disagree with itself", () => {
  it("projects onto the exporter's column set, which is narrower than the row", () => {
    assert.equal(LEAD_FIELD_PICK.fields.values, LEAD_EXPORT_FIELDS, "the pick table is the export array object");
    assert.equal(EXPORT_CREATE.fields.values, LEAD_FIELD_PICK.fields.values, "so both reads and the exporter read one array");
    assert.ok(LEAD_EXPORT_FIELDS.length < 33, "the vocabulary is not the whole table");
    for (const join of ["listMemberships", "_count"]) {
      assert.equal((LEAD_EXPORT_FIELDS as readonly string[]).includes(join), false, `${join} is a join, not a name anybody can ask for`);
    }
  });

  it("asks Prisma for exactly the named columns and nothing alongside them", () => {
    assert.deepEqual(leadSelect(["email", "score", "status"]), { email: true, score: true, status: true });
    assert.deepEqual(Object.keys(leadSelect(["email"])), ["email"]);
  });

  it("advertises the same parameter at both read doors of the contract", () => {
    const spec = openapiSpec.paths as Record<string, Record<string, { parameters?: { name: string }[]; responses: Record<string, unknown> }>>;
    const leads = spec["/api/leads"].get!;
    const lists = spec["/api/lead-lists/{id}"].get!;
    assert.ok((leads.parameters ?? []).some((p) => p.name === "fields"), "the leads door documents fields");
    assert.ok((lists.parameters ?? []).some((p) => p.name === "fields"), "the list door still documents fields");
    assert.ok("400" in leads.responses && "400" in lists.responses, "and both say what a bad name costs");
    const described = (leads.parameters ?? []).find((p) => p.name === "fields") as unknown as { description: string };
    assert.match(described.description, /Export\.fields/, "the description points at the door that already took these names");
  });
});

describe("the refusals are the same refusals the list door gives", () => {
  it("answers a name nobody has with the vocabulary, not the page", async () => {
    const { refusal } = await judge("?fields=nonsense");
    assert.ok(refusal, "a nonsense column is refused");
    assert.equal(refusal!.status, 400);
    const printed = message(refusal!).replace(/^.*must be one of /, "").replace(/, got.*$/, "").split(" | ");
    assert.ok(printed.length > 1, `the refusal names what may be asked: ${printed.length} entries`);
    for (const name of printed) {
      assert.equal((LEAD_EXPORT_FIELDS as readonly string[]).includes(name), true, `${name} is in the message and in the array`);
    }
    assert.deepEqual([...printed].sort(), [...LEAD_EXPORT_FIELDS].sort(), "the message is the array, in order, entire");
  });

  it("refuses an empty entry by position, including in the middle of a good list", async () => {
    assert.match(message((await judge("?fields=")).refusal!), /fields\[0\] must be a non-empty string/);
    assert.match(message((await judge("?fields=email,,score")).refusal!), /fields\[1\] must be a non-empty string/);
  });

  it("refuses a column's own capitalisation", async () => {
    assert.match(message((await judge("?fields=Email")).refusal!), /fields\[0\] must be one of/);
  });

  it("caps the ask at the same hundred the export door caps at", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `c${i}`).join(",");
    assert.match(message((await judge(`?fields=${many}`)).refusal!), /fields holds 300 entries; at most 100/);
  });

  it("dedupes, merges repeats and trims padding instead of refusing them", async () => {
    assert.deepEqual((await judge("?fields=email,email")).picked, ["email"]);
    assert.deepEqual((await judge("?fields=email&fields=score")).picked, ["email", "score"]);
    assert.deepEqual((await judge("?fields=%20email%20")).picked, ["email"]);
  });

  it("keeps the neighbouring parameters untranslated, exactly as it does at the list door", () => {
    for (const query of ["?select=email", "?include=email", "?fields[]=email", "?fieldsx=email", "?limit=50"]) {
      assert.equal(fieldsParam(new URLSearchParams(query)), null, query);
    }
  });

  it("tells not asking from asking for nothing", async () => {
    assert.equal((await judge("?limit=50")).picked, null, "no fields parameter is the whole row, unchanged");
    assert.ok((await judge("?fields=")).refusal, "an empty ask is a refusal, not the whole row");
  });
});
