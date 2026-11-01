// Round #79: two doors answered a caller's words before they knew who was asking.
//
//   `POST /api/leads/{id}?action=add-to-list` validated `listId` three lines before it read the
//   lead, and `GET /api/lead-lists/{id}` validated `?fields=` before it looked the list up at all.
//   Measured on `ff38306` (`/tmp/opencode/r79_press_base.log`, thirty legs, `:3445` over
//   `leadworks_r79`): another workspace's lead with `{"listId": 42}` was a `400` about the body
//   rather than the row's `404`, and an anonymous `?fields=nonsense` handed the whole 676-byte
//   `Lead` column table to whoever typed it. Trunk then moved twice — first `aw-leadworks#97` and two
//   dependabot bumps (`e28c108`), then this round's own landing wave (`#108`, `#107`, `#115` →
//   `eb156ef`) — and all thirty legs were re-run on each
//   (`r79b_press_base.log`, then `r79d_press_base.log`, with `r79d_press_fix.log` / `r79d_press_ab.log`
//   for the third A/B): the same six legs move, the same twenty-four hold, the same two base byte
//   strings answer at all three builds, and those rebases are why the census pattern got wider (see
//   `WORDS` below). The fix is ordering, and ordering is a shape, so it is pinned by
//   reading the two handlers back and by a census over every handler that judges words.
//
// The census is branch-aware, and that is not a refinement: `POST_impl` in the leads file has an
// `enrich` branch that authenticates at its own top, so a scan of the whole handler body finds an
// `assertOwns` earlier than anything in the branch below it and clears the very door under
// investigation. The first version of this scan did exactly that.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectHandlers, authSites, blankComments, functionBody } from "./route-handlers";

const ROOT = process.cwd();
const at = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const LEADS = at("src/app/api/leads/[id]/route.ts");
const LISTS = at("src/app/api/lead-lists/[id]/route.ts");

/**
 * A door judging what the caller sent: a body schema, an id/list helper built on one, or a
 * query-string word judged by name.
 *
 * The last family was added when this round was rebased onto the trunk that took `aw-leadworks#97`
 * (`e28c108`). That round taught `GET /api/sources` to refuse an unknown `?type=` and
 * `?lastRunStatus=`, and it judges them through `filterParam` — a door answering a caller's word by
 * name that this pattern did not see, so `19 units` was a count of what the regex matched, not of
 * what the app does. `boolParam` (`?isActive=`) and `pageParams` (`?page=`, `?limit=`) are the same
 * family already present on trunk: `pageParams` clamps rather than refuses, but it still decides what
 * a caller's words mean, and the rule here is about ordering, not about which answer is given. The
 * widened scan measures 24 units, 2 of them covered by a shared head, 0 offenders; the five units the
 * old pattern missed are `enrichment-rules` GET, `exports` GET, `jobs` GET, `lead-lists` GET and
 * `sources` GET — all five authenticate above the judgement, which is why widening changed no verdict
 * and bought coverage.
 */
const WORDS = /(?:validateBody|stringList|asStrings|filterParam|boolParam|pageParams)\(/;

interface Unit {
  label: string;
  text: string;
  /** The handler authenticated before the dispatch, so the branch inherits that check. */
  covered: boolean;
}

/**
 * The `if (action === "x") { … }` blocks of a handler, with brace matching on the
 * comment-blanked text so a `{` in prose is not a block.
 */
function actionBranches(code: string): { name: string; start: number; body: string }[] {
  const found: { name: string; start: number; body: string }[] = [];
  const re = /if \(action === "([^"]+)"\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = code.indexOf("{", m.index);
    let depth = 0;
    let i = start;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    found.push({ name: m[1], start, body: code.slice(start, i + 1) });
  }
  return found;
}

/**
 * Every unit of control flow that judges a caller's words: a whole handler when it has no action
 * dispatch, one entry per branch when it does. A handler whose shared head authenticates marks its
 * branches covered — the check runs before the dispatch, so it dominates every branch below.
 */
function judgingUnits(code: string, label: string): Unit[] {
  const branches = actionBranches(code);
  const head = branches.length > 0 ? code.slice(0, branches[0].start) : code;
  const covered = branches.length > 0 && authSites(head).length > 0;
  const units: Unit[] = branches.length > 0
    ? branches.map((b) => ({ label: `${label} ?action=${b.name}`, text: b.body, covered }))
    : [{ label, text: code, covered: false }];
  return units.filter((u) => u.text.search(WORDS) >= 0);
}

/** Units that answer a caller's words before any check in the same unit has run. */
function offenders(units: Unit[]): string[] {
  const bad: string[] = [];
  for (const u of units) {
    if (u.covered) continue;
    const words = u.text.search(WORDS);
    const auth = authSites(u.text);
    if (auth.length === 0) {
      bad.push(`${u.label}: judges a caller's words with no auth call in the same branch`);
      continue;
    }
    if (words < Math.min(...auth.map((a) => a.index))) {
      bad.push(`${u.label}: words judged at ${words}, first auth (${auth.map((a) => a.name).join("/")}) at ${Math.min(...auth.map((a) => a.index))}`);
    }
  }
  return bad;
}

function allUnits(): Unit[] {
  const units: Unit[] = [];
  for (const h of collectHandlers()) units.push(...judgingUnits(blankComments(h.body), `${h.file} ${h.method}`));
  return units;
}

describe("the census: who judges a caller's words, and after what check", () => {
  const handlers = collectHandlers();

  it("sees every exported handler, so a door it cannot see is a failure", () => {
    // Fifty on the trunk this round landed onto (`aa2e380`, whose forty-nine were measured in round
    // #79), fifty-one here: `#59` adds `export-profiles/route.ts GET` and `export-profiles/[id]/route.ts
    // GET`, two doors the scanner could not have counted before the files existed. The count is the
    // scanner's visibility, so it moves with the app and is retargeted rather than relaxed.
    assert.equal(handlers.length, 51, "the scanner found a different number of handlers than this round measured");
  });

  it("finds twenty-five units that judge a caller's words", () => {
    // Twenty whole handlers and five action branches, counted with the widened `WORDS` above; the
    // trunk measured nineteen plus five, and `#59` adds the twentieth whole one:
    // `GET /api/export-profiles` judges `?page=` and `?limit=` through `pageParams`,
    // after `authedWorkspaceId` and against a `where` that is already the caller's own workspace.
    // A new door that validates is a new unit, and it has to be looked at rather than absorbed:
    // the count is the thing being asserted, and the ordering assertion below is what it is for.
    const units = allUnits();
    assert.equal(units.length, 25, "units: " + units.map((u) => u.label).join(" | "));
  });

  it("sees the query-string doors the first version of this scan did not", () => {
    // The five units `validateBody|stringList|asStrings` missed, named so that a sixth one arriving
    // fails here rather than lowering the census's own visibility unnoticed.
    const labels = allUnits().map((u) => u.label);
    for (const door of [
      "src/app/api/enrichment-rules/route.ts GET",
      "src/app/api/exports/route.ts GET",
      "src/app/api/jobs/route.ts GET",
      "src/app/api/lead-lists/route.ts GET",
      "src/app/api/sources/route.ts GET",
    ]) assert.ok(labels.includes(door), door + " is not among " + labels.join(" | "));
  });

  it("names both doors this round moved among them", () => {
    const labels = allUnits().map((u) => u.label);
    assert.ok(labels.includes("src/app/api/leads/[id]/route.ts POST ?action=add-to-list"), labels.join(" | "));
    assert.ok(labels.includes("src/app/api/lead-lists/[id]/route.ts GET"), labels.join(" | "));
  });

  it("reports no door answering words before it knows who is asking", () => {
    const bad = offenders(allUnits());
    assert.deepEqual(bad, [], bad.join("\n"));
  });

  it("treats a head that authenticates as covering its branches, and needs to", () => {
    const covered = allUnits().filter((u) => u.covered);
    assert.equal(covered.length, 2, "the two covered units are the list door's add/remove branches");
    assert.deepEqual(
      covered.map((u) => u.label).sort(),
      [
        "src/app/api/lead-lists/[id]/route.ts POST ?action=add-leads",
        "src/app/api/lead-lists/[id]/route.ts POST ?action=remove-leads",
      ].sort(),
    );
    // Those branches hold no auth call of their own, so without the head rule the census would
    // report two leaks that are not leaks.
    for (const u of covered) assert.equal(authSites(u.text).length, 0, u.label);
  });

  it("is branch-aware, because a whole-handler scan clears the door this round fixed", () => {
    // The trunk order, reconstructed: the body is judged at the top of the branch and the row is
    // read after it. Nothing else about the handler changes.
    const trunkBranch = `if (action === "add-to-list") {
    const rawBody = await readJson(request);
    const input = validateBody(rawBody.body, LEAD_ADD_TO_LIST);
    if (!input.ok) return input.error;
    const _owned = await prisma.lead.findUnique({ where: { id }, select: { workspaceId: true } });
    if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertOwns(request, _owned.workspaceId);
  }`;
    const postBody = blankComments(functionBody(LEADS, "POST_impl") ?? "");
    const withTrunk = postBody.replace(/if \(action === "add-to-list"\) \{[\s\S]*?\n  \}/, trunkBranch);
    assert.notEqual(withTrunk, postBody, "the add-to-list branch was not found to swap back");

    // Branch-blind: the enrich branch's assertOwns sits earlier in the same body, so the scan
    // passes. This is the assertion that makes the branch slicing above load-bearing.
    const blind = offenders([{ label: "blind", text: withTrunk, covered: false }]);
    assert.equal(blind.length, 0, "a whole-handler scan of the trunk order reports no offender");

    // Branch-aware: the same text, sliced, names the door by file, method and action.
    const seen = judgingUnits(withTrunk, "src/app/api/leads/[id]/route.ts POST");
    const bad = offenders(seen);
    assert.equal(bad.length, 1, bad.join("\n"));
    assert.match(bad[0], /leads\/\[id\]\/route\.ts POST \?action=add-to-list/);
  });

  it("refuses to absorb a door that judges words with no check anywhere in its branch", () => {
    const synthetic = `if (action === "nope") {
    const input = validateBody(body, LEAD_PATCH);
    if (!input.ok) return input.error;
    return NextResponse.json(input.data);
  }`;
    const units = judgingUnits(synthetic, "synthetic POST");
    const bad = offenders(units);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /no auth call in the same branch/);
  });
});

describe("the pair door: whose lead, then what body", () => {
  const code = blankComments(functionBody(LEADS, "POST_impl") ?? "");
  const branch = judgingUnits(code, "POST").find((u) => u.label.includes("add-to-list"))!.text;

  it("still asks for parseable JSON first, the rule PATCH_impl in the same file follows", () => {
    assert.ok(branch.indexOf("readJson(") < branch.indexOf("prisma.lead.findUnique"), "a body that is not JSON is a body problem");
  });

  it("reads the row, asserts it, and only then judges the body", () => {
    const lead = branch.indexOf("prisma.lead.findUnique");
    const owns = branch.indexOf("assertOwns(request, _owned.workspaceId)");
    const words = branch.search(WORDS);
    assert.ok(lead >= 0 && owns > lead && words > owns, `read=${lead} owns=${owns} words=${words}`);
  });

  it("gives the missing lead the row's own refusal, before any sentence about the body", () => {
    const notFound = branch.indexOf('NextResponse.json({ error: "Not found" }, { status: 404 })');
    assert.ok(notFound >= 0 && notFound < branch.search(WORDS), "the 404 for the row must precede the schema");
  });

  it("keeps the same schema and the same sentence for a listId that is not text", () => {
    assert.equal((branch.match(/validateBody\(raw\.body, LEAD_ADD_TO_LIST\)/g) ?? []).length, 1);
    assert.match(LEADS, /LEAD_ADD_TO_LIST/);
  });

  it("reads the list only once the body has named it, and owns it before the pair is written", () => {
    const words = branch.search(WORDS);
    const list = branch.indexOf("prisma.leadList.findUnique");
    const listOwns = branch.indexOf("assertOwns(request, list.workspaceId)");
    const write = branch.indexOf("prisma.leadListMember.create");
    assert.ok(words < list && list < listOwns && listOwns < write, `words=${words} list=${list} owns=${listOwns} write=${write}`);
  });

  it("writes the pair with create, and took on no fold this round", () => {
    assert.match(branch, /prisma\.leadListMember\.create\(\{ data: \{ listId, leadId: id \} \}\)/);
    assert.doesNotMatch(branch, /skipDuplicates/, "the duplicate answer at this door is #111's open work");
  });

  it("leaves the enrich branch exactly as it was measured: authenticates, then makes a job", () => {
    // The branch is taken from the dispatch itself, not from `judgingUnits`, because `enrich`
    // validates no body at all — which is why the census never counts it.
    const enrich = actionBranches(code).find((b) => b.name === "enrich")!.body;
    assert.ok(enrich.indexOf("assertOwns(request, _owned.workspaceId)") < enrich.indexOf("prisma.job.create"), "that branch is the model, not the target");
  });

  it("answers an unknown action above the dispatch now, because #75 wrote the reader this tail deferred to", () => {
    // Retargeted, not deleted, and by the round that made it true. This pin existed because the pair
    // door answered `400 "Unknown action"` at the *end* of `POST_impl` — after both branches, so an
    // anonymous or padded ask about a row another tenant held was refused below the lookup that knows
    // the row. #79 disclosed that rather than fixing it (`README.md:4581`, "still a 400 at both
    // builds"); `actionParam` is what closed it, and the two assertions below are the order #75
    // promised: the reader runs above both branches, and the old literal survives only as the
    // fallback a passed-but-unhandled spelling would reach.
    const reader = code.indexOf("actionParam(searchParams, LEAD_ACTIONS)");
    assert.ok(reader >= 0, "the pair door no longer reads the action word through this app's reader");
    assert.ok(reader < code.indexOf('action === "enrich"'), "the word is judged above the branches, not after them");
    assert.match(code, /return asked\.error \?\? NextResponse\.json\(\{ error: "Unknown action" \}, \{ status: 400 \}\);/);
  });
});

describe("the list read door: whose list, then which field", () => {
  const code = blankComments(functionBody(LISTS, "GET_impl") ?? "");

  it("resolves the row and asserts it before it reads a field name", () => {
    const owns = code.indexOf("assertOwns(request, _owned.workspaceId)");
    assert.ok(owns >= 0, "no ownership check found in the read door");
    assert.ok(owns < code.indexOf("fieldsParam(searchParams)"), "the door still opens its column table to strangers");
    assert.ok(owns < code.search(WORDS), "and still validates a field before it knows who sent it");
  });

  it("takes two columns for that decision and nothing else", () => {
    assert.match(code, /prisma\.leadList\.findUnique\(\{ where: \{ id \}, select: \{ workspaceId: true \} \}\)/);
    assert.ok(code.indexOf("select: { workspaceId: true }") < code.indexOf("include: {"), "the cheap read comes first");
  });

  it("refuses a row that is not there before it says anything about a column", () => {
    const notFound = code.indexOf('NextResponse.json({ error: "Not found" }, { status: 404 })');
    assert.ok(notFound >= 0 && notFound < code.indexOf("fieldsParam(searchParams)"));
  });

  it("keeps the projection refusal for the caller who owns the row", () => {
    const words = code.search(WORDS);
    assert.ok(words > code.indexOf("assertOwns(request, _owned.workspaceId)"), "the refusal survived, it only moved");
    assert.match(code, /validateBody\(\s*\{\s*fields:\s*asked\s*\},\s*LEAD_FIELD_PICK\s*\)/);
  });

  it("reads the members second, and keeps its own not-found for a row deleted in between", () => {
    const members = code.indexOf("include: {");
    assert.ok(members > code.indexOf("fieldsParam(searchParams)"), "the projection still decides the read on the way to the database");
    const tail = code.slice(members);
    assert.match(tail, /if \(!list\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
    assert.doesNotMatch(tail, /assertOwns\(request, list\.workspaceId\)/, "ownership is decided once, above the projection");
  });

  it("still answers the page arithmetic from the recorded count", () => {
    assert.match(code, /memberPage\(recorded, list\.members\.length, page, limit\)/);
    assert.ok(code.indexOf("pageParams(searchParams, 100)") > code.indexOf("assertOwns(request, _owned.workspaceId)"));
  });
});

describe("the doors that were already in this order", () => {
  it("PATCH /api/leads/{id}: parse, row, owns, body", () => {
    const code = blankComments(functionBody(LEADS, "PATCH_impl") ?? "");
    const parse = code.indexOf("readJson(request)");
    const row = code.indexOf("prisma.lead.findUnique");
    const owns = code.indexOf("assertOwns(request, before.workspaceId)");
    const words = code.search(WORDS);
    assert.ok(parse < row && row < owns && owns < words, `parse=${parse} row=${row} owns=${owns} words=${words}`);
  });

  it("PATCH and POST /api/lead-lists/{id} read the row before they read the request's mind", () => {
    for (const [name, ownsVar] of [["PATCH_impl", "_owned.workspaceId"], ["POST_impl", "_owned.workspaceId"]] as const) {
      const code = blankComments(functionBody(LISTS, name) ?? "");
      const owns = code.indexOf(`assertOwns(request, ${ownsVar})`);
      const words = code.search(WORDS);
      assert.ok(owns >= 0, `${name} has no ownership check`);
      assert.ok(owns < words, `${name} judges a caller's words at ${words} before it owns at ${owns}`);
    }
  });

  it("GET and DELETE /api/leads/{id} keep the order this round copied", () => {
    for (const name of ["GET_impl", "DELETE_impl"]) {
      const code = blankComments(functionBody(LEADS, name) ?? "");
      assert.ok(code.indexOf("prisma.lead.findUnique") < code.indexOf("assertOwns"), name);
    }
  });
});

describe("the document already promised the key, and still does", () => {
  const spec = at("src/lib/openapi.ts");

  it("puts auth: key on both doors", () => {
    assert.match(spec, /id: "leads\.enrich",\n\s+summary: [^\n]+\n\s+auth: "key",/);
    assert.match(spec, /id: "leadLists\.get",\n\s+summary: [^\n]+\n\s+auth: "key",/);
  });

  it("still documents the list read door's 400 as a column problem only", () => {
    const get = spec.slice(spec.indexOf('id: "leadLists.get"'));
    assert.match(get.slice(0, 900), /"400": "A `fields` entry that is not a Lead column, or names nothing\."/);
  });

  it("advertises the 400 the pair door answers, and still not the 401", () => {
    // The other half of the same retarget. #79 pressed that this door's `400` and `401` were both
    // absent from the document — the refusal a caller hits most often, unadvertised — and pinned the
    // absence because that was the measured state. #75 put the `400` in, with the sentence naming the
    // three spellings `actionParam` refuses, so the pin now holds the document to what changed: the
    // `400` is promised, and the `401` is the disclosure still open.
    const post = spec.slice(spec.indexOf('id: "leads.enrich"'), spec.indexOf('id: "leads.delete"'));
    assert.match(post, /"400": "[^"]*action[^"]*/, "the word refusal is advertised where the door answers it");
    assert.doesNotMatch(post, /"401":/, "the auth status is still not in the document, and this round did not change that");
  });

  it("still documents listId as the list to add to", () => {
    assert.match(
      spec,
      /listId: \{ type: "string", description: "The list to add the lead to \(action=add-to-list only\)\." \}/,
      "the prose this round made true is pinned so it cannot be reworded back into a leak",
    );
  });
});

describe("the README section says what was measured", () => {
  const readme = at("README.md");
  const start = readme.indexOf("\n## Whose row is this?");
  const end = readme.indexOf("\n## Score:", start);
  const section = readme.slice(start, end);

  it("sits where the round put it", () => {
    assert.ok(start > 0, "the section is missing");
    assert.ok(end > start, "the section does not end at ## Score");
    assert.ok(section.length > 1000, "the section is too short to hold its tables");
  });

  it("quotes the base answer as a measurement", () => {
    assert.match(section, /Measured on the running app/);
    assert.match(section, /ff38306/);
    assert.match(section, /:3445/);
    assert.match(section, /leadworks_r79/);
  });

  it("says the press was run three times because trunk moved twice, and what stayed the same", () => {
    // The round's own honesty clause: trunk moved under this branch twice — once while it was open
    // (`e28c108`), once because this session landed three of its siblings (`eb156ef`) — so the README
    // must show each re-measurement rather than quietly keep the older bytes.
    assert.match(section, /Pressed three times, because trunk moved/);
    assert.match(section, /e28c108/);
    assert.match(section, /eb156ef/);
    assert.match(section, /r79b_press_base\.log/);
    assert.match(section, /r79d_press_base\.log/);
    assert.match(section, /1adb29fd6478/, "the pair door's base reply, at all three trunk hashes");
    assert.match(section, /00c3cfb06f0f/, "the list door's base reply, at all three trunk hashes");
    assert.match(section, /src\/lib\/ids\.ts/, "and which landed round rewrote the bytes it pressed");
  });

  it("carries the six legs that moved, with their bytes", () => {
    const needles = ["400` / 101", "400` / 676", "`404 / 22`", "`404 / 21`", "`401 / 64`", "`400 / 101`", "`400 / 676`"];
    for (const needle of needles) {
      assert.ok(section.includes(needle), "the section never quotes " + needle);
    }
    assert.match(section, /exactly the \*\*six legs above change\*\*/);
  });

  it("says how many legs held, and what they held", () => {
    assert.match(section, /Twenty-four of the thirty legs answer the same at both builds/);
    assert.match(section, /Twenty-two are byte-identical/);
    assert.match(section, /482 B and 1068 B/);
    assert.match(section, /`B7`[\s\S]{0,400}?400 \/ 676/, "the owner still hears the column table");
  });

  it("names the contract as unchanged, with the measured digest", () => {
    assert.match(section, /75,013 B, sha256 `d9fad003d779`/);
    assert.match(section, /byte-identical between the two builds by `cmp`/);
    // The number changed twice because trunk changed twice, and the section has to say so rather
    // than swap it silently: 73,195 → 74,401 (`#97`) → 75,013 (`#107`, `#108`).
    assert.match(section, /73,195 B[\s\S]{0,140}?74,401 B[\s\S]{0,200}?75,013 B/);
  });

  it("reports the census pattern widening with its reason, not just its new count", () => {
    assert.match(section, /24 units judge a caller's words/);
    assert.match(section, /the count went 19 → 24, the offenders stayed `0`/);
    assert.match(section, /filterParam/);
    assert.match(section, /`enrichment-rules`, `exports`, `jobs`/,
      "the five doors the first pattern missed are named");
  });

  it("reports the retarget rather than hiding it", () => {
    assert.match(section, /tests\/unit\/list-fields\.test\.ts:194/);
    assert.match(section, /retargeted rather than relaxed/);
  });

  it("keeps the open work open, and the demo blocked", () => {
    assert.match(section, /aw-leadworks#111/);
    assert.match(readme, /aw-deploy#96` is still `CONFLICTING/);
  });

  it("says what it did not do, and does not do it", () => {
    assert.match(section, /No migration, no schema, no new status/);
    assert.doesNotMatch(section, /skipDuplicates/, "the duplicate answer at this door is #111's open work, not this round's");
    assert.doesNotMatch(section, /added a column|migrated the/i, "the section must not claim the change it refuses");
  });
});
