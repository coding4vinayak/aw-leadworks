// #76: the pair that was already true refused the work that was not. Measured on the running
// app (`ff38306`, built in a fresh worktree, :3439 over this session's own `leadworks_r76`,
// private Redis 6422, keys read from `0600` files and printed nowhere; presses in
// `/tmp/opencode/r76_press_ab.log` and `/tmp/opencode/r76_press_extra.log`). `lst_r76_partial`
// held `ld_r76_1` and nothing else, and `ld_r76_2` was a lead of the same workspace that was on
// no list:
//
//   POST /api/lead-lists/{partial}?action=add-leads {"leadIds":["ld_r76_1"]}
//     409 / 130 B {"conflict":{"fields":["listId","leadId"]},
//                  "error":"A LeadListMember with this listId + leadId already exists…"}
//   POST …?action=add-leads {"leadIds":["ld_r76_1","ld_r76_2"]}
//     409 / 130 B, same body — and the list read back holding `ld_r76_1` alone, so the crowd's
//     other half was never written: `createMany` is one statement and the pair that collided
//     rolled the pair that did not out with it
//   POST …?action=add-leads {"leadIds":["ld_r76_2","ld_r76_3","ld_r76_4"]}  (at a list already
//     holding all three)   409 / 130 B, nothing changed
//   POST /api/leads/{ld_r76_1}?action=add-to-list {"listId":"…partial"}
//     409 / 130 B, same sentence
//
//   POST …?action=remove-leads {"leadIds":["ld_r76_9"]}  (not a member)
//     200 / 11 B {"ok":true}    <- the same door, the same shape of nothing-to-do
//
// So an already-true *removal* was a no-op and an already-true *addition* was a failure that
// also discarded the caller's other rows, while `POST /api/leads` folds a repeated `listIds`
// entry with `skipDuplicates` and `csv-import.ts` counts what the index settled "so the report
// always adds up". This pins the fold, the arithmetic, and the refusals that must not be folded
// with it.
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankComments, callArgs } from "./route-handlers";
import { asStrings } from "../../src/lib/ids";
import { membershipReport } from "../../src/lib/membership-add";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CROWD = "../../src/app/api/lead-lists/[id]/route.ts";
const PAIR = "../../src/app/api/leads/[id]/route.ts";

/**
 * Every `prisma.leadListMember.createMany(` the app writes, with its arguments read off the code
 * — `src/generated` is the Prisma client's own declarations, not a write site, so the walk stops
 * outside it rather than counting a type signature as a call.
 */
function memberAdds(): { file: string; args: string[] }[] {
  const found: { file: string; args: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const here = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(here);
      else if (entry.name.endsWith(".ts")) {
        const code = blankComments(at(here));
        for (const match of code.matchAll(/prisma\.leadListMember\.createMany\s*\(/g)) {
          found.push({ file: here, args: callArgs(code, (match.index ?? 0) + match[0].length - 1) });
        }
      }
    }
  };
  for (const dir of ["../../src/app", "../../src/lib", "../../src/components"]) walk(dir);
  return found;
}

describe("the arithmetic a membership write owes", () => {
  it("calls a fresh crowd exactly what it is", () => {
    assert.deepEqual(membershipReport(3, 3), { ok: true, requested: 3, added: 3, already: 0 });
  });

  it("calls an already-true pair nothing left to do, and still `ok`", () => {
    // The verdict `remove-leads` has always given for the mirror-image case.
    assert.deepEqual(membershipReport(1, 0), { ok: true, requested: 1, added: 0, already: 1 });
  });

  it("adds up for every answer the index can hand back", () => {
    for (let requested = 1; requested <= 5; requested++) {
      for (let added = 0; added <= requested; added++) {
        const report = membershipReport(requested, added);
        assert.equal(report.added + report.already, requested, `${requested}/${added}`);
        assert.ok(report.already >= 0, `${requested}/${added} reported a negative crowd`);
        assert.equal(report.ok, true);
      }
    }
  });

  it("counts a lead the caller named twice as one request", () => {
    // `asStrings` de-duplicates, so `requested` is the crowd and not the typing: a caller who
    // sent `["ld_r76_1","ld_r76_1"]` is owed `requested: 1`, never `already: 1` for a repeat
    // this app folded before it reached the index.
    assert.deepEqual(asStrings(["ld_r76_1", "ld_r76_1", "ld_r76_2"], "leadIds").values, ["ld_r76_1", "ld_r76_2"]);
    assert.deepEqual(asStrings([" ld_r76_1 ", "ld_r76_1"], "leadIds").values, ["ld_r76_1"]);
    const crowd = asStrings(["ld_r76_1", "ld_r76_1", "ld_r76_2"], "leadIds").values!;
    assert.deepEqual(membershipReport(crowd.length, 1), { ok: true, requested: 2, added: 1, already: 1 });
  });
});

describe("every membership add in the app folds, and the census says how many there are", () => {
  it("finds the three the crowd door, the refresh writer and the pair door make", () => {
    const sites = memberAdds();
    assert.equal(sites.length, 3, `the census saw ${sites.map((s) => s.file).join(", ")}`);
    assert.equal(sites.filter((s) => s.file === CROWD).length, 2);
    assert.equal(sites.filter((s) => s.file === PAIR).length, 1);
  });

  it("requires each one to say what happens to a pair that is already there", () => {
    for (const site of memberAdds()) {
      assert.ok(
        site.args.some((a) => /skipDuplicates:\s*true/.test(a)),
        `${site.file} adds memberships without skipDuplicates, so the unique index answers it as a 409`,
      );
    }
  });

  it("leaves the nested write alone, because the lead it pairs with does not exist yet", () => {
    // `POST /api/leads` creates the memberships inside `prisma.lead.create`, against an id that
    // was generated in the same statement, so it cannot collide and is not this rule's to apply.
    const route = blankComments(at("../../src/app/api/leads/route.ts"));
    assert.equal((route.match(/listMemberships:\s*\{\s*create:/g) ?? []).length, 1);
    assert.equal(route.includes("leadListMember.createMany"), false, "the create door writes pairs twice over");
  });

  it("keeps the arithmetic in the module and out of the doors, where it could drift", () => {
    for (const door of [CROWD, PAIR]) {
      assert.match(at(door), /from "@\/lib\/membership-add"/);
      assert.match(at(door), /membershipReport\(/);
      // Neither door is allowed to re-type the fields, which is how one door ends up with a
      // number the other does not have.
      assert.equal(blankComments(at(door)).includes("already:"), false, `${door} computes "already" itself`);
    }
  });

  it("leaves the removal side exactly as measured, so the no-op baseline holds", () => {
    const crowd = at(CROWD);
    const remove = crowd.slice(crowd.indexOf('action === "remove-leads"'), crowd.indexOf('action === "refresh"'));
    assert.match(remove, /deleteMany/);
    assert.match(remove, /NextResponse\.json\(\{ ok: true \}\)/);
    assert.equal(remove.includes("membershipReport"), false, "the removal answer moved under this round's press");
    assert.equal(remove.includes("skipDuplicates"), false, "a delete has nothing to fold");
  });
});

describe("what must not be folded with it", () => {
  it("checks the crowd against the workspace before the write, so a stranger is not `already`", () => {
    const body = blankComments(at(CROWD));
    const add = body.slice(body.indexOf('action === "add-leads"'), body.indexOf('action === "remove-leads"'));
    const foreign = add.indexOf('leadIds must belong to this workspace');
    const unknown = add.indexOf('unknownIdsError("leadIds"');
    const empty = add.indexOf("leadIds required");
    const write = add.indexOf("prisma.leadListMember.createMany");
    assert.ok(0 < empty && empty < foreign && foreign < unknown && unknown < write, "the fold ran ahead of a refusal");
  });

  it("resolves the pair door's list before it writes, as before", () => {
    const body = blankComments(at(PAIR));
    const add = body.slice(body.indexOf('action === "add-to-list"'));
    const missing = add.indexOf('List not found');
    const owns = add.indexOf("assertOwns(request, list.workspaceId)");
    const write = add.indexOf("prisma.leadListMember.createMany");
    assert.ok(0 < missing && missing < owns && owns < write, "the pair door wrote before it knew whose list it was");
  });

  it("keeps `conflictFor` for the models that really collide, and out of these two doors", () => {
    // #67's translator still stands behind `POST /api/leads`, `PATCH /api/leads/{id}` and the
    // workspace slug; `tests/unit/unique-index.test.ts` pins that, and nothing here moved it.
    assert.match(at("../../src/lib/apikeys.ts"), /P2002/);
    assert.match(at("../../src/lib/apikeys.ts"), /uniqueViolationColumns/);
    for (const door of [CROWD, PAIR]) {
      assert.equal(blankComments(at(door)).includes("conflictFor"), false, `${door} refuses a pair it could fold`);
    }
  });

  it("reports the refresh writer's `added` as what landed, and keeps the other five numbers", () => {
    const body = blankComments(at(CROWD));
    const refresh = body.slice(body.indexOf('action === "refresh"'));
    assert.match(refresh, /added = done\[addAt\]\.count/);
    assert.match(refresh, /await prisma\.\$transaction\(writes\)/);
    const del = refresh.indexOf("leadListMember.deleteMany");
    const add = refresh.indexOf("leadListMember.createMany");
    const tx = refresh.indexOf("await prisma.$transaction(writes)");
    assert.ok(del < add && add < tx, "the membership write is no longer one unit, removal first");
    for (const field of ["matched", "removed", "kept", "members", "filter"]) {
      assert.match(at(CROWD), new RegExp(`\\b${field}:`), `the refresh answer dropped ${field}`);
    }
  });
});

describe("what the contract tells a caller the answer is", () => {
  const operation = (id: string) => openapiOperations.find((o) => o.operation.id === id)!.operation;
  const answers = (id: string) => operation(id).responses as Record<string, string>;

  it("says the crowd answers with numbers, and never calls it the list", () => {
    const text = answers("leadLists.members")["200"];
    assert.match(text, /requested/);
    assert.match(text, /already/);
    assert.match(text, /answers 200/);
    assert.doesNotMatch(text, /The list as it now reads/, "the door answers what it did, not the row");
    for (const field of ["matched", "added", "removed", "kept", "members", "filter"]) {
      assert.ok(text.includes(field), `the refresh half of the answer went undocumented`);
    }
  });

  it("says the pair answers with the same numbers", () => {
    const text = answers("leads.enrich")["200"];
    assert.match(text, /requested/);
    assert.match(text, /added/);
    assert.match(text, /already/);
    assert.match(text, /added: 0/);
  });

  it("advertises no 409 for a pair that is already there, at either door", () => {
    // The 409 `leadLists.members` does advertise is the refresh refusal, which is a different
    // fact: a stored filter that cannot be re-run.
    const text = answers("leadLists.members")["409"];
    assert.match(text, /^`refresh` on a dynamic list whose stored filter cannot be read/);
    // The first version of this pin looked for "already exists" and was shown to be no pin at
    // all: re-advertising the collision as "or a lead the list already holds" walked straight
    // through it. The sentence is now required to be the refresh refusal and nothing else.
    assert.doesNotMatch(text, /add-leads|already|duplicate|pair/i);
    assert.equal(answers("leads.enrich")["409"], undefined, "the pair door still advertises a collision");
  });
});
