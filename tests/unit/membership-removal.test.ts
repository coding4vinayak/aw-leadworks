// #78 — `?action=remove-leads` answered a verdict without its numbers, pinned offline.
//
// Measured on a live instance (aw-leadworks at `ff38306`, this session's own worktree, booted on
// :3443 over `leadworks_r78`, private Redis 6426; presses in `/tmp/opencode/r78_press_base.log`).
// One static list holding three of the workspace's four leads, the same request path and the same
// key, six different truths about the same body:
//
//   remove ["ld_r78_1"]                          removed one        -> 200 / 11 {"ok":true}
//   remove ["ld_r78_4"]                          removed none       -> 200 / 11 {"ok":true}
//   remove ["ld_r78_1","ld_r78_4"]               removed one of two -> 200 / 11 {"ok":true}
//   remove ["ld_r78_1","ld_r78_2","ld_r78_3"]    removed all three  -> 200 / 11 {"ok":true}
//   remove ["ld_nope_r78"]                       no such lead       -> 200 / 11 {"ok":true}
//   remove ["ld_r78_b1"]                         another tenant's   -> 200 / 11 {"ok":true}
//
// Every one byte-identical. A typo, an idempotent retry and a full removal were the same answer,
// and the caller could not tell the list had changed at all. The branch next to it — `?action=refresh`
// on the same handler — had always reported `removed` and `kept`, and `csv-import.ts` counts what
// the index settled. This round gives the removal branch that arithmetic: `requested` (the folded
// crowd), `removed` (the rows `deleteMany` returned) and `absent` (the rest).
//
// What this file pins, in the order the code runs:
//
//   1. the arithmetic, over every pair the door can produce;
//   2. `requested` is the crowd `asStrings` reads, not the raw array — a lead named twice is one;
//   3. the wiring, scanned from the source with comments blanked: the count comes from the
//      `deleteMany` in the same statement, the answer is the report, and the refusals still come
//      first;
//   4. the no-op stays a 200: the removal branch did not grow the add door's 403/422 checks;
//   5. the contract's `200` sentence says what the door answers and no longer claims a list;
//   6. the README's own claims — the base table and the fixed answer — are the measured ones.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { asStrings } from "../../src/lib/ids";
import { membershipRemoval } from "../../src/lib/membership-remove";
import { blankComments, functionBody } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const listIdRoute = at("../../src/app/api/lead-lists/[id]/route.ts");
const openapi = at("../../src/lib/openapi.ts");
const readme = at("../../README.md");
const helperSource = at("../../src/lib/membership-remove.ts");

// The branch's prose quotes the answers that were wrong before it, so every scan of what the code
// reaches for runs on the source with comments blanked; offsets are preserved.
const postCode = blankComments(functionBody(listIdRoute, "POST_impl") ?? "");
const removeAt = postCode.indexOf('if (action === "remove-leads") {');
const refreshAt = postCode.indexOf('if (action === "refresh") {');
assert.ok(removeAt >= 0 && refreshAt > removeAt, "the scanner found no remove-leads branch to pin");
const removeCode = postCode.slice(removeAt, refreshAt);
const refreshCode = postCode.slice(refreshAt);

describe("the arithmetic a removal owes", () => {
  it("reports what was asked, what came off, and what was already absent", () => {
    assert.deepEqual(membershipRemoval(3, 3), { ok: true, requested: 3, removed: 3, absent: 0 });
    assert.deepEqual(membershipRemoval(2, 1), { ok: true, requested: 2, removed: 1, absent: 1 });
    assert.deepEqual(membershipRemoval(1, 0), { ok: true, requested: 1, removed: 0, absent: 1 });
  });

  it("always adds up: removed + absent === requested, and absent is never negative", () => {
    for (let requested = 0; requested <= 8; requested++) {
      for (let removed = 0; removed <= requested; removed++) {
        const report = membershipRemoval(requested, removed);
        assert.equal(report.removed + report.absent, requested, `${requested}/${removed} did not add up`);
        assert.ok(report.absent >= 0);
        assert.equal(report.ok, true, "already absent is success, said — never a refusal");
      }
    }
  });

  it("is arithmetic on the count, not a second query for it", () => {
    assert.match(blankComments(helperSource), /absent: requested - removed/);
  });

  it("requests the crowd as this app reads one: a lead named twice is asked for once", () => {
    const folded = asStrings(["ld_a", "ld_a", " ld_b "], "leadIds");
    assert.deepEqual(folded.values, ["ld_a", "ld_b"]);
    assert.equal(folded.values.length, 2);
  });
});

describe("the door answers through that rule", () => {
  it("takes the count from the delete it performs, in the same statement", () => {
    assert.match(removeCode, /const \{ count \} = await prisma\.leadListMember\.deleteMany\(\s*\{\s*where: \{ listId: id, leadId: \{ in: parsed\.values \} \},?\s*\}\s*\)/);
    assert.match(removeCode, /NextResponse\.json\(membershipRemoval\(parsed\.values\.length, count\)\)/);
  });

  it("imports the rule rather than re-typing its fields", () => {
    assert.match(listIdRoute, /import \{ membershipRemoval \} from "@\/lib\/membership-remove"/);
    assert.equal((removeCode.match(/membershipRemoval\(/g) ?? []).length, 1);
    assert.doesNotMatch(removeCode, /ok: true, requested/);
    assert.doesNotMatch(removeCode, /absent: parsed\.values\.length - count/);
  });

  it("counts the crowd it asked for, never the raw body array", () => {
    assert.doesNotMatch(removeCode, /leadIds\.length/);
    assert.doesNotMatch(removeCode, /body\.leadIds/);
  });

  it("keeps the refusals in front of the write, and the write in front of the answer", () => {
    const parse = removeCode.indexOf("asStrings(leadIds, \"leadIds\")");
    const empty = removeCode.indexOf("leadIds required");
    const del = removeCode.indexOf("leadListMember.deleteMany");
    const answer = removeCode.indexOf("membershipRemoval(");
    assert.ok(parse >= 0 && parse < empty && empty < del && del < answer,
      "a removal ran, or answered, before it knew what the caller asked for");
  });

  it("leaves the no-op a 200: none of the add door's 403/422 checks grew here", () => {
    for (const gate of ["prisma.lead.findMany", "missingIds(", "unknownIdsError(", "assertOwns("]) {
      assert.equal(removeCode.includes(gate), false, `the removal branch gained ${gate}, which would refuse an already-absent id`);
    }
    // The empty-crowd refusal legitimately has its `400`; the delete and everything after it do not.
    const afterDelete = removeCode.slice(removeCode.indexOf("leadListMember.deleteMany"));
    assert.doesNotMatch(afterDelete, /status:\s*4\d\d/, "a removal that took off nothing is still a success");
  });

  it("is the sibling of the refresh answer, which already reported its removals", () => {
    assert.match(refreshCode, /removed: plan\.remove\.length/);
    assert.equal((postCode.match(/leadListMember\.deleteMany/g) ?? []).length, 2,
      "the handler's two removals — the explicit one and the refresh's — are both still here");
  });
});

describe("the contract says what the door answers", () => {
  // The leadLists.members entry, from its id to the next path.
  const entry = openapi.slice(openapi.indexOf('id: "leadLists.members"'), openapi.indexOf('id: "leadLists.delete"'));

  it("names the three numbers and the no-op they make legible", () => {
    assert.match(entry, /`requested`/);
    assert.match(entry, /`removed`/);
    assert.match(entry, /`absent`/);
    assert.match(entry, /`removed: 0`/);
    assert.match(entry, /already absent is success/);
  });

  it("no longer claims a list it never returned", () => {
    assert.doesNotMatch(entry, /The list as it now reads/);
    assert.doesNotMatch(entry, /"200": "The list/);
  });
});

describe("the README states the measurement, not a claim", () => {
  // The phrase `## Score` also appears in earlier rounds' prose, so the slice starts from the
  // heading itself and ends at the one heading that owns the score table.
  const from = readme.indexOf("\n## One removal, three answers");
  const section = readme.slice(from, readme.indexOf("\n## Score:"));

  it("sits where the round put it, before the score table", () => {
    assert.ok(from >= 0 && section.length > 400, "the README has no round-#78 section to pin");
  });

  it("quotes every base leg with the reply they shared", () => {
    for (const leg of ['["ld_r78_1"]', '["ld_r78_4"]', '["ld_nope_r78"]', '["ld_r78_b1"]']) {
      assert.ok(section.includes(leg), `the section does not quote ${leg}`);
    }
    assert.equal((section.match(/200 \/ 11/g) ?? []).length >= 5, true, "the base replies were byte-identical; the table must show it");
  });

  it("shows the fixed answer for the same legs and both suite measurements", () => {
    const code = blankComments(section);
    assert.match(code, /"removed":\s?1,\s?"absent":\s?0/);
    assert.match(code, /"removed":\s?0,\s?"absent":\s?1/);
    assert.match(readme, /1336\/1336/);
    assert.match(readme, /1352\/1352/);
  });

  it("keeps the no-demo disclosure beside the round that has none", () => {
    assert.match(section, /aw-deploy#96/);
    assert.match(section, /CONFLICTING/);
  });
});
