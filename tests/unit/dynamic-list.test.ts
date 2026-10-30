// #44 — `LeadList.isDynamic` and `LeadList.filterJson` read as the two columns' own comments
// promise, pinned offline.
//
// `prisma/schema.prisma` spells `filterJson Json? // Filter criteria for dynamic lists` beside
// `isDynamic Boolean @default(false)`; `LEAD_LIST_CREATE` and `LEAD_LIST_PATCH` both sell them.
// Nothing in `src/` read either one. The single door that could act on them answered, measured on
// the running app before this round:
//
//   POST /api/lead-lists/{id}?action=refresh {isDynamic:true}
//     -> 200 {"ok":true,"message":"Dynamic list refresh not fully implemented"}
//
// with the membership unchanged on both sides of it, `?action=refresh` *without* the flag a
// `400 "Unknown action"` (the branch keyed on the caller's body, not the row), and
// `filterJson: { a: 1 }` and `filterJson: []` both stored as 201.
//
// What this file pins, in the order the code runs:
//
//   1. what a list's filter is allowed to say, and the three refusals;
//   2. that the vocabulary is the one reader's, not a second copy that can drift;
//   3. the one place a list deliberately reads differently from a rule, so the difference is a
//      test and not a comment;
//   4. the membership diff — the half that decides what a dynamic list *is*;
//   5. what the door owes for a row that is not dynamic and for one whose filter cannot be run;
//   6. the wiring itself, scanned from the source: the two doors call these functions in order,
//      the body's flag is gone, the admission is gone, and nothing was stored in a new column.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CONDITION_KEYS, conditionsProblem, readStoredConditions } from "../../src/lib/rule-conditions";
import { listRefreshAsk, planListRefresh, readListFilter } from "../../src/lib/dynamic-list";
import { blankComments, functionBody } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const listCreateRoute = at("../../src/app/api/lead-lists/route.ts");
const listIdRoute = at("../../src/app/api/lead-lists/[id]/route.ts");
const moduleSource = at("../../src/lib/dynamic-list.ts");
const ruleConditionsSource = at("../../src/lib/rule-conditions.ts");
const exporterSource = at("../../src/lib/exporter.ts");
const readme = at("../../README.md");
const schema = at("../../prisma/schema.prisma");

// The prose of this round quotes the state that was wrong before it (a `body.isDynamic` a caller
// could type, a `not fully implemented` admission), so every scan of what the code reaches for is
// a scan of the code with comments blanked — `blankComments` keeps offsets, so an order pin still
// means the order the file runs in.
const moduleCode = blankComments(moduleSource);
const postCode = blankComments(functionBody(listIdRoute, "POST_impl") ?? "");
const refreshCode = postCode.slice(postCode.indexOf('if (action === "refresh") {'));
assert(refreshCode.length > 200, "the scanner found no refresh branch to pin");

describe("what a list's filter is allowed to say", () => {
  it("takes one value and gives the list the reader works with", () => {
    const read1 = readListFilter({ status: "QUALIFIED" });
    assert.equal(read1.problem, null);
    assert.deepEqual(read1.filter, { status: ["QUALIFIED"] });
  });

  it("takes the whole vocabulary — status, seniority, score bounds, tags", () => {
    const read1 = readListFilter({ status: ["NEW", "ENRICHED"], seniority: "c_level", score: { gte: 80, lte: 96 }, tags: ["vip"] });
    assert.equal(read1.problem, null);
    assert.deepEqual(read1.filter, { status: ["NEW", "ENRICHED"], seniority: ["C_LEVEL"], score: { gte: 80, lte: 96 }, tags: ["vip"] });
  });

  it("keeps a tag exactly as written, because the column compares JSON values", () => {
    assert.deepEqual(readListFilter({ tags: "VIP" }).filter, { tags: ["VIP"] });
  });

  it("refuses a list that declares nothing to re-run", () => {
    for (const empty of [undefined, null]) {
      const verdict = readListFilter(empty);
      assert.equal(verdict.filter.status, undefined);
      assert.match(String(verdict.problem), /declares no filter to re-run/);
    }
  });

  it("refuses a filter that says nothing about anybody", () => {
    assert.match(String(readListFilter({}).problem), /says nothing about any lead/);
    assert.match(String(readListFilter({}).problem), new RegExp(CONDITION_KEYS.join(", ")));
  });

  it("refuses a key no Lead column can hold, and names the vocabulary", () => {
    const verdict = readListFilter({ department: "Ops" });
    assert.match(String(verdict.problem), /"department" is not an attribute a dynamic list can condition on/);
    assert.match(String(verdict.problem), new RegExp(`the supported keys are ${CONDITION_KEYS.join(", ")}`));
  });

  it("refuses the shapes that were 201 before this round", () => {
    for (const blob of [[], 42, "hello", true]) {
      assert.notEqual(readListFilter(blob).problem, null, `${JSON.stringify(blob)} was stored as a filter`);
    }
  });

  it("refuses a filter that would select nobody as much as one that selects everybody", () => {
    assert.match(String(readListFilter({ status: [] }).problem), /asks for no lead at all/);
    assert.match(String(readListFilter({ score: { gte: 90, lte: 40 } }).problem), /no number is both/);
    assert.match(String(readListFilter({ score: { gte: 250 } }).problem), /the column is 0-100/);
  });
});

describe("the vocabulary is the one reader's, not a second copy", () => {
  it("delegates every blob it does not itself refuse", () => {
    for (const blob of [{ department: "Ops" }, { status: "MIDDLE" }, { score: 12 }, { status: [] }, {}, []]) {
      const own = readListFilter(blob).problem;
      const shared = conditionsProblem(blob, "a dynamic list");
      if (shared !== null) {
        assert.equal(own, shared, `${JSON.stringify(blob)} was refused differently by the two`);
      } else {
        assert.match(String(own), /says nothing about any lead/);
      }
    }
  });

  it("owns no key list of its own", () => {
    assert.equal(/const\s+[A-Z_]+\s*=\s*\[/.exec(moduleSource.slice(moduleSource.indexOf("export function readListFilter")))?.[0], undefined);
    assert.equal(moduleSource.includes('"status", "seniority", "score", "tags"'), false);
  });

  it("calls the shared validator and the shared normalizer exactly once each", () => {
    assert.equal((moduleSource.match(/conditionsProblem\(/g) ?? []).length, 1);
    assert.equal((moduleSource.match(/normalizeConditions\(/g) ?? []).length, 1);
  });
});

describe("a list is not a rule: nothing declared is refused, not defaulted", () => {
  it("shows the two readings disagreeing on purpose", () => {
    const rule = readStoredConditions({});
    assert.equal(rule.problem, null);
    assert.deepEqual(rule.conditions, { status: ["NEW", "ENRICHED"] });
    assert.notEqual(readListFilter({}).problem, null);
  });

  it("and agrees on a crowd, because the same words must select the same leads", () => {
    assert.deepEqual(readListFilter({ status: "NEW", tags: ["vip"] }).filter, readStoredConditions({ status: "NEW", tags: ["vip"] }).conditions);
  });
});

describe("the membership diff a refresh writes", () => {
  it("adds what the filter names and the list lacks, removes what the list holds and the filter does not name", () => {
    const plan = planListRefresh(["a", "b", "c"], ["c", "d", "e"]);
    assert.deepEqual(plan.add, ["d", "e"]);
    assert.deepEqual(plan.remove, ["a", "b"]);
    assert.deepEqual(plan.keep, ["c"]);
    assert.equal(plan.matched, 3);
  });

  it("is a no-op when the crowd has not moved", () => {
    const plan = planListRefresh(["a", "b"], ["b", "a"]);
    assert.deepEqual(plan.add, []);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.keep, ["a", "b"]);
  });

  it("empties a list whose filter names nobody, and fills one from nothing", () => {
    assert.deepEqual(planListRefresh(["a", "b"], []), { keep: [], add: [], remove: ["a", "b"], matched: 0 });
    assert.deepEqual(planListRefresh([], ["a"]), { keep: [], add: ["a"], remove: [], matched: 1 });
  });

  it("counts distinct leads, not rows handed to it", () => {
    const plan = planListRefresh(["a", "a", "b"], ["b", "b", "c"]);
    assert.equal(plan.matched, 2);
    assert.deepEqual(plan.add, ["c"]);
    assert.deepEqual(plan.remove, ["a"]);
    assert.equal(plan.keep.length + plan.add.length, plan.matched);
  });

  it("gives the same answer for the same two sets in any order", () => {
    const one = planListRefresh(["x", "y", "z"], ["y", "z", "w"]);
    const other = planListRefresh(["z", "x", "y"], ["w", "y", "z"]);
    assert.deepEqual(one, other);
  });

  it("holds no query, no clock and no disk", () => {
    for (const forbidden of ["prisma", "await", "new Date(", "node:fs", "process.env"]) {
      assert.equal(moduleCode.includes(forbidden), false, `the module reached for ${forbidden}`);
    }
    assert.equal((moduleCode.match(/^import .*$/gm) ?? []).length, 1);
    assert.match(moduleCode, /from "\.\/rule-conditions"/);
  });
});

describe("what the refresh door owes", () => {
  it("refuses a list that is not dynamic, and says whose members they are", () => {
    const ask = listRefreshAsk(false, null);
    assert.equal(ask.ok, false);
    assert.equal(ask.http, 400);
    assert.match(String(ask.error), /isDynamic.*false/);
    assert.match(String(ask.error), /no filter to re-run/);
  });

  it("refuses a dynamic list whose stored filter cannot be run, with the row's own state quoted", () => {
    const problem = readListFilter({ department: "Ops" }).problem;
    const ask = listRefreshAsk(true, problem);
    assert.equal(ask.ok, false);
    assert.equal(ask.http, 409);
    assert.match(String(ask.error), /cannot be re-run as written/);
    assert.ok(String(ask.error).includes(String(problem)));
  });

  it("keeps the two refusals apart, because they are two facts", () => {
    assert.notEqual(listRefreshAsk(false, null).http, listRefreshAsk(true, "x").http);
  });

  it("lets only a dynamic row with a readable filter through", () => {
    const ask = listRefreshAsk(true, null);
    assert.deepEqual(ask, { ok: true, http: 200, error: null });
  });

  it("asks the row and never the request body", () => {
    assert.equal(postCode.includes("body.isDynamic"), false, "the refresh branch still obeyed the caller's flag");
    assert.equal(postCode.includes("body.filterJson"), false, "the refresh branch still obeyed the caller's filter");
    assert.match(refreshCode, /listRefreshAsk\(_owned\.isDynamic, stored\.problem\)/);
  });
});

describe("the doors call this module, in the order the answers need", () => {
  it("refuses an unreadable filter at the create door before anything is stored", () => {
    const validate = listCreateRoute.indexOf("validateBody(body, LEAD_LIST_CREATE)");
    const refuse = listCreateRoute.indexOf('readListFilter(input.data.filterJson)');
    const noFilter = listCreateRoute.indexOf('input.data.isDynamic === true && declared === null');
    const create = listCreateRoute.indexOf("prisma.leadList.create");
    assert.ok(validate < refuse && refuse < noFilter && noFilter < create, "the create door stored before it asked");
    assert.match(listCreateRoute, /status: 400/);
  });

  it("stores what the reader will read, at both doors", () => {
    assert.equal((listCreateRoute.match(/asInputJson\(declared\.filter\)/g) ?? []).length, 1);
    assert.equal((listIdRoute.match(/asInputJson\(declared\.filter\)/g) ?? []).length, 1);
  });

  it("asks the edit door about the arriving filter and about the row it would leave behind", () => {
    const declared = listIdRoute.indexOf('readListFilter(input.data.filterJson)');
    const willBeDynamic = listIdRoute.indexOf("const willBeDynamic");
    const stored = listIdRoute.indexOf("declared ?? readListFilter(_owned.filterJson)");
    const update = listIdRoute.indexOf("prisma.leadList.update");
    assert.ok(declared < willBeDynamic && willBeDynamic < stored && stored < update, "the edit door wrote before it asked");
    assert.match(listIdRoute, /"isDynamic" in input\.data \? input\.data\.isDynamic === true : _owned\.isDynamic/);
  });

  it("reads the row's own columns in both POST and PATCH", () => {
    assert.equal((listIdRoute.match(/select: \{ workspaceId: true, isDynamic: true, filterJson: true \}/g) ?? []).length, 2);
  });

  it("asks the mark of the row before it reads a single lead", () => {
    const branch = refreshCode.indexOf('if (action === "refresh") {');
    const ask = refreshCode.indexOf("if (!ask.ok)");
    const findMany = refreshCode.indexOf("prisma.lead.findMany");
    assert.ok(-1 < branch && branch < ask && ask < findMany, "a refresh selected leads before it knew the row was dynamic");
    assert.match(refreshCode, /leadWhere\(_owned\.workspaceId, stored\.filter\)/);
  });

  it("writes the two halves as one transaction, removal first", () => {
    const del = refreshCode.indexOf("leadListMember.deleteMany");
    const add = refreshCode.indexOf("leadListMember.createMany");
    const tx = refreshCode.indexOf("await prisma.$transaction(writes)");
    assert.ok(del < add && add < tx, "the membership write was not one unit");
    // The other two `leadListMember` writes are `?action=add-leads` and `?action=remove-leads`,
    // each a single statement that needs no transaction; a refresh is the only caller here.
    assert.equal((listIdRoute.match(/prisma\.\$transaction\(/g) ?? []).length, 1);
    assert.equal((refreshCode.match(/leadListMember\.deleteMany/g) ?? []).length, 1);
    assert.equal((refreshCode.match(/leadListMember\.createMany/g) ?? []).length, 1);
    assert.equal((listIdRoute.match(/leadListMember\.deleteMany/g) ?? []).length, 2);
    assert.equal((listIdRoute.match(/leadListMember\.createMany/g) ?? []).length, 2);
  });

  it("answers with the arithmetic a caller can check against the crowd", () => {
    // #76 widened the pattern below, not the field list: `added` is now the database's insert
    // count rather than the plan's length, so it is written as the shorthand `added,` in the
    // answer object. Six fields, each still required, none still allowed to go missing.
    for (const field of ["matched", "added", "removed", "kept", "members", "filter"]) {
      assert.match(listIdRoute, new RegExp(`\\b${field}[:,]`), `the refresh answer omitted ${field}`);
    }
    assert.match(listIdRoute, /describeConditions\(stored\.filter\)/);
  });

  it("has taken the admission out of the repository, and leaves it in the README only as the answer that was measured", () => {
    assert.equal(listIdRoute.includes("not fully implemented"), false);
    const quoted = readme.split("\n").filter((line) => line.includes("Dynamic list refresh not fully implemented"));
    assert.equal(quoted.length, 1, "the README quotes the old answer more than once, so a reader cannot tell history from behavior");
    assert.match(quoted[0], /^\s*-> /, "and it quotes it as a measured response, never as what the door does now");
  });

  it("invented no status, no event and no column to keep score of the click", () => {
    const block = schema.slice(schema.indexOf("model LeadList {"), schema.indexOf("\nmodel ", schema.indexOf("model LeadList {")));
    const fields = [...block.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]);
    assert.deepEqual(fields, ["id", "workspaceId", "name", "description", "isDynamic", "filterJson", "createdAt", "updatedAt", "workspace", "members"]);
    assert.equal(block.includes("refresh"), false);
    assert.equal(block.includes("lastError"), false);
  });

  it("is imported by the two list doors and by nothing pretending to be a rule", () => {
    assert.match(listCreateRoute, /from "@\/lib\/dynamic-list"/);
    assert.match(listIdRoute, /from "@\/lib\/dynamic-list"/);
    assert.equal(ruleConditionsSource.includes("dynamic-list"), false);
    assert.equal(exporterSource.includes("dynamic-list"), false);
  });
});
