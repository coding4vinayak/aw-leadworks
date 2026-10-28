// #68 — an export's `filterJson.listId` names a list, and nothing asked whether it does.
//
// Measured on the running app before any of this shipped (`e3fcc16` built in a fresh
// worktree, served on **:3420** over this round's own database `leadworks_r69`, private
// Redis 6411, two workspaces, keys in `0600` files printed nowhere; `r69_press_base.log`
// and `r69_extras_base.log`). Workspace A held three leads — `ana@x.com` and `bo@x.com`
// in a list `lst_r69_a`, `cy@x.com` outside it — and tenant B held `lst_r69_b` with one
// lead of its own. Each leg below is `POST /api/exports {"format":"CSV",
// "fields":["email","status"], "filterJson": <this>}`, polled to a terminal status, then
// downloaded:
//
//   {"listId":"lst_r69_a"}   201 COMPLETED recordCount=2 fileSize=46  header + 2 rows
//   {"listId":"nope"}        201 COMPLETED recordCount=0 fileSize=0   200, ZERO bytes
//   {"listId":"lst_r69_b"}   201 COMPLETED recordCount=0 fileSize=0   200, ZERO bytes
//   {"listId":"  lst_r69_a  "}  201 COMPLETED recordCount=0 fileSize=0 — the list exists
//   {"listId":""}            201 COMPLETED recordCount=0 fileSize=0
//   {"listId":42}            400 filterJson.listId must be a string
//   {"listId":["a","b"]}     400 filterJson.listId must be a string
//
// while the same name at the doors that already resolve it was answered by name, on the
// same build:
//
//   GET  /api/leads?listId=nope          422 listId is not an id this workspace has: nope
//   GET  /api/leads?listId=lst_r69_b     422 (another tenant's name is not a crowd)
//   GET  /api/leads?listId=%20lst_r69_a%20  200 — and that list's two leads
//   POST /api/leads {listIds:["nope"]}   422 listIds holds 1 id this workspace does not have
//   POST /api/leads {listIds:[""]}       400 every listIds entry must be a non-empty string
//   POST /api/leads {listIds:["  lst_r69_a  "]}  201, filed under the list — it trims
//   POST /api/exports {profileId:"nope"} 422 profileId is not an id this workspace has
//   POST /api/exports?profileId=nope     422 the same sentence from the same door's GET
//
// So the export door resolved the profile it was pointed at and refused a word inside the
// filter, but the one key of that filter that names a *row* went through: a caller who
// typo'd a list id received a finished export and an empty file, and the file was not even
// a header line — zero bytes, which is also what a render that failed on the way out would
// have delivered. This is #58's defect arriving from the body side: that round landed the
// read door's `?listId=`; this is the door that *stores* the name.
//
// Nothing here needs a browser, a database or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import { EXPORT_FILTER_KEYS, EXPORT_LIST_ID, exportFilter, exportFilterProblem, readExportFilter } from "../../src/lib/export-format";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const exportsDoor = at("../../src/app/api/exports/route.ts");
const exporter = at("../../src/lib/exporter.ts");

// The three refusals and the one judgement, read straight off the module.
test("a padded name is the name, here as at every other door", () => {
  assert.deepEqual(readExportFilter({ listId: "  lst_r69_a  " }), { listId: "lst_r69_a" });
  assert.deepEqual(readExportFilter({ listId: "\tlst_r69_a " }), { listId: "lst_r69_a" });
  assert.deepEqual(readExportFilter({ listId: "lst_r69_a" }), { listId: "lst_r69_a" }, "an id with nothing to strip is untouched");
});

test("the judgement does not rewrite the caller's blob", () => {
  const sent = { listId: "  x  ", status: "NEW" };
  assert.deepEqual(readExportFilter(sent), { listId: "x", status: "NEW" });
  assert.deepEqual(sent, { listId: "  x  ", status: "NEW" }, "the caller's object is left as it arrived");
});

test("an empty name is refused rather than filed as a crowd of zero", () => {
  for (const empty of ["", "   ", "\t"]) {
    assert.throws(
      () => readExportFilter({ listId: empty }),
      /^Error: filterJson\.listId must name a list; "" is not a list$/,
      `padding-only ${JSON.stringify(empty)} names nothing either`,
    );
  }
});

test("the kind refusals the door already spoke are unchanged, byte for byte", () => {
  for (const wrong of [42, true, ["lst_r69_a", "lst_r69_b"], { id: "x" }, null]) {
    assert.throws(
      () => readExportFilter({ listId: wrong }),
      /^Error: filterJson\.listId must be a string$/,
      `${JSON.stringify(wrong)} is not a name`,
    );
  }
});

test("a name is judged by its own rules and the rest of the filter keeps its words", () => {
  // The trim must not travel: `tags` and `status` are values in columns, and a
  // `status` that is not one of the set is refused by the sentence #56 landed, not by
  // this round's.
  assert.deepEqual(readExportFilter({ listId: "  x  ", tags: ["hot"] }), { listId: "x", tags: ["hot"] });
  assert.throws(() => readExportFilter({ listId: "  x  ", status: "ACTIVE" }), /must be one of NEW \| ENRICHED/);
  assert.deepEqual(readExportFilter({ tags: ["  "] }), { tags: ["  "] }, "a tag entry's emptiness is the tags rule, not this one");
});

test("nothing about an unresolvable name is decided by a module that cannot reach the database", () => {
  const judged = exportFilter({ listId: "nope" });
  assert.deepEqual(judged, { filter: { listId: "nope" }, problem: null }, "it exists somewhere is the door's question");
});

test("exportFilter keeps the value it judged, and the sentence-only reader is unchanged", () => {
  assert.deepEqual(exportFilter({ listId: "  x  " }).filter, { listId: "x" });
  assert.equal(exportFilter({ listId: "" }).problem, 'filterJson.listId must name a list; "" is not a list');
  assert.deepEqual(exportFilter({ listId: "" }).filter, {}, "a refused filter is not half-written");
  assert.equal(exportFilter(undefined).problem, null);
  assert.deepEqual(exportFilter(undefined).filter, {});
  assert.deepEqual(exportFilter(null).filter, {});
  for (const bad of [{ temperature: "hot" }, { status: "qualified" }, "text", [1], { listId: 42 }]) {
    assert.equal(exportFilterProblem(bad), exportFilter(bad).problem, "the two readers cannot drift");
  }
});

test("the refusal names the place the value arrived, the way the word refusal does", () => {
  assert.equal(EXPORT_LIST_ID, "filterJson.listId");
  assert.ok(EXPORT_FILTER_KEYS.includes("listId"), "and the key it is named under is one the filter takes");
  assert.equal(EXPORT_LIST_ID, `filterJson.${EXPORT_FILTER_KEYS[3]}`, "prefix plus key, spelled once");
});

test("POST /api/exports resolves the name before it writes either row", () => {
  const body = functionBody(blankComments(exportsDoor), "POST_impl") ?? "";
  assert.match(body, /const named = asked\.filter\.listId;/, "the trimmed name is what is asked about");
  assert.match(body, /if \(typeof named === "string"\)/, "absent and null stay the no-opinion request they are");
  assert.match(body, /prisma\.leadList\.count\(\{ where: \{ workspaceId, id: named \} \}\)/,
    "scoped to this workspace, so another tenant's id answers like a id that exists nowhere");
  assert.match(body, /unknownIdError\(EXPORT_LIST_ID, named\)/, "the door's own 422, not a 400 invented for this key");
  const refusal = body.indexOf("unknownIdError(EXPORT_LIST_ID");
  assert.ok(refusal < body.indexOf("prisma.export.create"), "the refusal returns before a row exists");
  assert.ok(refusal > body.indexOf("validateBody(body, EXPORT_CREATE)"), "after the shape is known to be a filter");
  assert.ok(body.indexOf("exportFilter(input.data.filterJson)") < refusal, "and after the word and key checks");
});

test("the door files the filter it judged, not the bytes that arrived", () => {
  const body = functionBody(blankComments(exportsDoor), "POST_impl") ?? "";
  assert.match(body, /const declared = typeof input\.data\.filterJson === "object" && input\.data\.filterJson !== null\s*\n?\s*\? asInputJson\(asked\.filter\)/);
  assert.match(body, /\.\.\.\(declared === undefined \? \{\} : \{ filterJson: declared \}\)/,
    "the stored row and the queued config are the same object");
  assert.equal(body.match(/filterJson: declared/g)!.length, 2, "one for the Export row, one for the Job config");
  assert.doesNotMatch(body, /filterJson: input\.data\.filterJson/, "the raw blob is not stored twice, once judged and once not");
});

test("the worker reads the same judge, so a stored name and a compared name cannot drift", () => {
  assert.match(exporter, /const filter = readExportFilter\(config\.filterJson\);/);
  assert.match(exporter, /if \(typeof filter\.listId === "string"\) where\.listMemberships = \{ some: \{ listId: filter\.listId \} \};/);
  assert.doesNotMatch(exporter, /config\.filterJson\.listId/, "the worker never reads the raw blob for this key");
});

test("no read door was involved, and no new query parameter opened", () => {
  const body = functionBody(blankComments(exportsDoor), "POST_impl") ?? "";
  assert.doesNotMatch(body, /searchParams/, "the POST half takes a body");
  assert.equal((body.match(/EXPORT_LIST_ID/g) ?? []).length, 1, "the door spells the name once, at the refusal");
  assert.equal((exportsDoor.match(/EXPORT_LIST_ID/g) ?? []).length, 2, "import and use, and no literal alongside them");
  assert.doesNotMatch(body, /unknownIdError\("filterJson/, "the sentence is not re-typed at the call");
});

test("the contract prices the refusal it now makes, and splits the statuses honestly", () => {
  const door = openapiOperations.find((entry) => entry.operation.id === "exports.create");
  if (!door) throw new Error("exports.create is not in the contract");
  const responses = door.operation.responses as Record<string, string>;
  assert.match(responses["422"], /`listId` inside `filterJson`/, "the new refusal is advertised where the body is described");
  assert.match(responses["422"], /profileId/, "and the one that was already answered is not orphaned by a 400 sentence");
  assert.doesNotMatch(responses["400"], /profileId/, "a 400 does not claim a refusal the door gives as a 422");
  const properties = (door.operation as any).body.properties;
  assert.match(properties.filterJson.description, /`listId` here names one of your lists/);
  assert.match(properties.filterJson.description, /padding is not part of the id/);
  assert.match(properties.filterJson.description, /a list this workspace does not have is refused at the door/);
  assert.doesNotMatch(properties.filterJson.description, /records=0/, "the contract says what the door does, not what the old build did");
});

test("the sentences this round replaced are pinned, not left to a passing suite", () => {
  // #56's word refusal and this round's name refusal share one function, so both
  // messages are quoted here rather than trusted from a diff.
  assert.throws(
    () => readExportFilter({ status: "ACTIVE" }),
    /^Error: filterJson\.status must be one of NEW \| ENRICHED \| QUALIFIED \| CONTACTED \| CONVERTED \| REJECTED, got "ACTIVE"$/,
  );
  assert.throws(
    () => readExportFilter({ temperature: "hot" }),
    /^Error: filterJson key "temperature" is not supported — use status, minScore, maxScore, listId, tags$/,
  );
  assert.throws(
    () => readExportFilter([["listId", "x"]]),
    /^Error: filterJson must be an object like \{"status":"QUALIFIED"\}$/,
  );
});
