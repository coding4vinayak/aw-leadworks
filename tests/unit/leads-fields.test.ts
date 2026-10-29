// #47: `GET /api/leads` did not read `fields`, even though the sibling door two
// routes away started obeying it in #46. Measured against the running app on this
// PR's own base (`origin/main` at `4a88f17`, built in a throwaway worktree) and on
// this round's build, both against one database holding a crowd of 300 imported
// leads, 100 of them on one list (/tmp/opencode/r47_probe_after.mjs against the
// base on :3315 and against the fix on :3314):
//
//   ?limit=50                              -> 200, 105,536 bytes, 35 keys per row
//   ?limit=50&fields=email,score,status    -> 200, 105,536 bytes, 35 keys
//   ?limit=50&fields=email                 -> 200, 105,536 bytes, 35 keys
//   ?limit=50&fields=nonsense              -> 200, 105,536 bytes — a 200, not a refusal
//   ?limit=50&select=email                 -> 200, 105,536 bytes
//
// Eleven spellings of "give me less than the row", and all eleven cost 105,536
// bytes. On the fix the same door over the same database still answers the page it
// was asked not to project with 105,536, and answers `?fields=email,score,status`
// with 3,346 bytes — 31.5× less, one column being 2,019 — because `scoreBreakdown`,
// the nested `listMemberships` and `_count` are a column and two joins this caller
// never named. That the unprojected branch answers the identical number on both
// builds is the check that no projection leaks into the branch that asks for none;
// the page size itself is not guaranteed across runs, because `score desc` has no
// tiebreaker and an imported crowd ties everywhere.
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
    // Retargeted by #74, which gave the order its tiebreaker: the pin is stricter, not looser.
    // It still requires one shared `pageWindow` feeding both branches, and now requires that the
    // order it feeds them with is total — a projection that reordered the page was the old risk,
    // and a page sliced out of a tie was the new one.
    assert.match(
      window,
      /orderBy:\s*\[\s*\{\s*score:\s*"desc"(?: as const)?\s*\},\s*PAGED_TIEBREAK\s*\]/,
      "a projection must not reorder the page, and the page must not be cut out of a tie",
    );
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

/**
 * The `Lead` model's own scalar columns, read out of the schema the migrations are
 * generated from — the witness that the askable set is a subset of the row and is
 * not the row, without a database.
 */
const leadColumns = (() => {
  const schema = at("../../prisma/schema.prisma");
  const block = schema.slice(schema.indexOf("model Lead {") + "model Lead {".length, schema.indexOf("\n}", schema.indexOf("model Lead {")));
  const columns: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("@@") || line.includes("@relation")) continue;
    const parsed = /^(\w+)\s+([\w?]+)(\[\])?/.exec(line);
    if (!parsed || parsed[3]) continue;
    columns.push(parsed[1]);
  }
  return columns;
})();

describe("the vocabulary is the exporter's 25 names, and the row's other columns are not askable", () => {
  it("reads the schema's Lead columns, so the claims below are about the table and not about this file", () => {
    assert.equal(leadColumns.length, 33, `the model declares ${leadColumns.length} scalar columns`);
    for (const name of LEAD_EXPORT_FIELDS) {
      assert.equal(leadColumns.includes(name), true, `${name} is askable, so it must be a column`);
    }
  });

  it("keeps the arithmetic out of the askable set: the column that was 55% of a page", async () => {
    assert.equal((LEAD_EXPORT_FIELDS as readonly string[]).includes("scoreBreakdown"), false);
    assert.ok((await judge("?fields=scoreBreakdown")).refusal, "the breakdown is not a column anybody can name");
  });

  it("keeps a typed override and the scoring stamp out of it too", async () => {
    for (const name of ["scoreOverride", "scoredAt"]) {
      assert.ok((await judge(`?fields=${name}`)).refusal, `${name} is a stored fact, not an askable column`);
    }
  });

  it("keeps the validation trail and the two contact stamps out of it", async () => {
    for (const name of ["validationResults", "lastEnrichedAt", "lastContactedAt"]) {
      assert.equal(leadColumns.includes(name), true, `${name} is on the row`);
      assert.ok((await judge(`?fields=${name}`)).refusal, `${name} is not askable`);
    }
  });

  it("keeps the row's workspace identity and raw provenance out of it", async () => {
    for (const name of ["workspaceId", "sourceRef"]) {
      assert.ok((await judge(`?fields=${name}`)).refusal, `${name} identifies where the row came from, not what it says`);
    }
  });

  it("leaves exactly eight columns unaskable, and names them", async () => {
    const unaskable = leadColumns.filter((c) => !(LEAD_EXPORT_FIELDS as readonly string[]).includes(c));
    assert.deepEqual(
      [...unaskable].sort(),
      ["lastContactedAt", "lastEnrichedAt", "scoreBreakdown", "scoreOverride", "scoredAt", "sourceRef", "validationResults", "workspaceId"].sort(),
      "the gap between the row and the vocabulary is a decided list, not an accident",
    );
  });

  it("refuses a join by name, so a projected page cannot be asked back into carrying one", async () => {
    for (const join of ["listMemberships", "_count", "activities", "enrichmentLogs", "jobResults"]) {
      assert.equal(leadColumns.includes(join), false, `${join} is a relation, not a column`);
      assert.ok((await judge(`?fields=${join}`)).refusal, `${join} cannot be named`);
    }
  });

  it("holds one name per column, in one order, for all three doors to share", () => {
    assert.equal(new Set(LEAD_EXPORT_FIELDS).size, LEAD_EXPORT_FIELDS.length, "no duplicate name in the array");
    assert.equal(LEAD_EXPORT_FIELDS.length, 25, "the 25 names the two read doors print in a refusal");
  });

  it("refuses a prototype key as a column, and builds its select as a plain object", async () => {
    assert.ok((await judge("?fields=__proto__")).refusal, "a name that reaches the prototype is not a column");
    assert.ok((await judge("?fields=constructor")).refusal);
    const select = leadSelect(["email"]) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(select), Object.prototype, "the select is a plain object");
    assert.deepEqual(Object.getOwnPropertyNames(select), ["email"], "and carries only the column asked for");
  });
});

describe("the count, the window and the envelope stay one question either side of the projection", () => {
  it("counts without a select, so `total` is the crowd rather than the projection", () => {
    const count = /prisma\.lead\.count\(\{[^)]*\}\)/.exec(GET)?.[0] ?? "";
    assert.match(count, /\{ where \}/, "the count is over the filtered crowd");
    assert.equal(count.includes("select"), false, "a projected page does not narrow what `total` means");
    assert.equal(count.includes("take"), false, "and does not count a page rather than a crowd");
  });

  it("builds the filtered crowd once, before the column names are judged", () => {
    assert.ok(GET.indexOf("const where") < GET.indexOf("fieldsParam"), "one `where`, assembled before the ask");
    for (const filter of ["listId", "status", "minScore", "maxScore"]) {
      assert.match(GET, new RegExp(`where\\.${filter} =|where\\.score = `), `${filter} still reaches the crowd`);
    }
  });

  it("writes the skip arithmetic once, for both branches", () => {
    assert.equal((GET.match(/\(page\s*-\s*1\)\s*\*\s*limit/g) ?? []).length, 1, "one window, not two that can drift");
    assert.equal((GET.match(/\.\.\.pageWindow/g) ?? []).length, 2, "both reads spread it");
  });

  it("keeps the door's own page size: default 50, and the cap is the shared one", () => {
    assert.match(route, /pageParams\(searchParams, 50\)/, "the lead door still defaults to 50 rows");
    assert.equal((route.match(/pageParams\(/g) ?? []).length, 1, "no second paging decision in the file");
    // Retargeted by #60, not relaxed: this pin used to insist the two score bounds went through
    // `intParam`, whose rule for a page size — an unreadable value falls back to a default — is
    // wrong for a filter, because a default bound is a different crowd. The bounds now go
    // through the rule that refuses instead; the paging assertions above are the page-size rule,
    // unchanged, and still one of them in the file.
    assert.match(route, /scoreParam\(searchParams, "minScore"\)/);
    assert.match(route, /scoreParam\(searchParams, "maxScore"\)/);
    assert.equal(route.includes('intParam(searchParams, "minScore"'), false, "no silent fallback left on a bound");
    assert.equal(route.includes('intParam(searchParams, "maxScore"'), false, "and none on the other");
  });

  it("answers the same five envelope keys either side of the projection, plus one", () => {
    assert.match(GET, /const envelope = \{ leads, total, page, limit, totalPages: Math\.ceil\(total \/ limit\) \}/);
    const unprojected = /: envelope\)/.test(GET);
    assert.equal(unprojected, true, "the branch that was asked for nothing adds nothing");
  });

  it("still says `force-dynamic`, so a projection cannot make the door cacheable", () => {
    assert.match(route, /export const dynamic = "force-dynamic"/);
    assert.match(route, /withAuth\(GET_impl\)/, "and the door is still wrapped by the same auth");
  });
});

describe("this round reached one door, not the neighbours", () => {
  const detail = blankComments(at("../../src/app/api/leads/[id]/route.ts"));
  const imported = blankComments(at("../../src/app/api/leads/import/route.ts"));
  const exports = blankComments(at("../../src/app/api/exports/route.ts"));
  const lists = blankComments(at("../../src/app/api/lead-lists/[id]/route.ts"));

  it("leaves the single-lead detail door alone", () => {
    for (const token of ["fieldsParam", "leadSelect", "leadFields", "LEAD_FIELD_PICK"]) {
      assert.equal(detail.includes(token), false, `the detail door still answers the whole row: ${token}`);
    }
  });

  it("leaves the intake door alone", () => {
    for (const token of ["fieldsParam", "leadSelect", "leadFields"]) {
      assert.equal(imported.includes(token), false, `the import door never learned to project: ${token}`);
    }
  });

  it("leaves the export door validating its own table", () => {
    assert.match(exports, /EXPORT_CREATE/, "the exporter still reads the array this door now shares");
    assert.equal(exports.includes("LEAD_FIELD_PICK"), false, "and not the read pick");
  });

  it("keeps the two read doors' words for their own questions", () => {
    assert.match(lists, /memberFields/, "the list door still names the member's projection");
    assert.equal(lists.includes("leadFields"), false, "and does not borrow this door's field");
    assert.equal(GET.includes("memberFields"), false, "nor does this door borrow the list's");
  });

  it("keeps the shared module to the two helpers it was written to hold", () => {
    const shared = at("../../src/lib/list-fields.ts");
    assert.deepEqual(
      [...shared.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort(),
      ["fieldsParam", "leadSelect"],
      "a third helper would mean a third door deciding columns its own way",
    );
  });
});

describe("the query string, at this door's own defaults", () => {
  it("reads `fields` beside every parameter the door already takes", async () => {
    const { picked, refusal } = await judge(
      "?workspaceId=w&listId=l&status=NEW&minScore=50&maxScore=90&page=2&limit=5&fields=email",
    );
    assert.equal(refusal, null, "the door's other parameters do not swallow the ask");
    assert.deepEqual(picked, ["email"]);
  });

  it("refuses a name made only of padding, by position", async () => {
    assert.match(message((await judge("?fields=%20%20")).refusal!), /fields\[0\] must be a non-empty string/);
  });

  it("refuses a list of nothing but separators", async () => {
    assert.match(message((await judge("?fields=,,,")).refusal!), /fields\[0\] must be a non-empty string/);
  });

  it("caps what the caller wrote, not what survives dedupe", async () => {
    const hundred = Array.from({ length: 100 }, () => "email").join(",");
    assert.deepEqual((await judge(`?fields=${hundred}`)).picked, ["email"], "a hundred repeats are one column");
    assert.match(
      message((await judge(`?fields=${hundred},email`)).refusal!),
      /fields holds 101 entries; at most 100/,
      "and the hundred-and-first is refused before it is deduped",
    );
  });

  it("splits an encoded comma the way it splits a literal one", async () => {
    assert.deepEqual((await judge("?fields=email%2Cscore")).picked, ["email", "score"]);
  });

  it("merges repeated parameters in the order they arrive", async () => {
    assert.deepEqual((await judge("?fields=score&fields=email&fields=score")).picked, ["score", "email"]);
  });
});
