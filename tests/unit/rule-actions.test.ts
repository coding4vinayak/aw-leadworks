// #32 — `EnrichmentRule.actions` read as the promise its comment makes, pinned offline.
//
// `prisma/schema.prisma` declares `actions Json // What enrichment to perform` and
// `RULE_CREATE` makes it required, so a rule cannot be stored without saying what it does.
// Nothing read it back — and one place read it *wrong*: `scheduler.ts` passed the whole
// JSON column to `shouldRunNow` as a cron string, so the required object became `""` and
// the SCHEDULED leg of the minute sweep answered false for every rule the API can create.
// Measured against the running app before the fix: two MANUAL rules over identical leads,
// one declaring `{ fields: ["industry"] }` and one `{ fields: ["seniority"] }`, left the
// same row — both wrote `seniority=C_LEVEL`, both left `industry` empty, both logged
// `SUCCESS fieldsEnriched=["seniority"]`, and each job carried `fields: []`. A SCHEDULED
// rule with the JSON the door demands queued 0 jobs across three sweep minutes; the same
// rule with a bare `"* * * * *"` in that column, which the door refuses to accept
// (`actions must be an object or an array, got a string`), queued one job a minute.
//
// What this file pins, in the order the code runs:
//
//   1. the vocabulary — that a field is one of `ENRICH_WRITABLE`, the columns
//      `lib/enrich-plan.ts` says a visit may write, and that a refusal names that list
//      rather than a second one this module keeps;
//   2. `actionsProblem` — every shape a caller can write into the column, and which of
//      them mean "the rule declares nothing";
//   3. the cadence — accepted only in the five fields the matcher actually reads, so a
//      rule that could never fire cannot be created;
//   4. the pairing the blob cannot state on its own — a cadence belongs to a SCHEDULED
//      rule and to nothing else;
//   5. what a reader gets back from a stored row, and the narrowing a declared list
//      applies to what a provider answered;
//   6. the wiring, scanned from the source — both doors refuse before they store, the run
//      door and the sweep carry the declared list into the job, the worker honours it, and
//      the column is nowhere left to be read as a cron string whole.
//
// The leads a visit actually touches are the demo's job (STEP 13); nothing listed here
// needs a database to be wrong.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, countCodeMentions, functionBody } from "./route-handlers";
import { ENRICH_WRITABLE } from "../../src/lib/enrich-plan";
import {
  ACTION_KEYS,
  actionsProblem,
  normalizeActions,
  readRuleActions,
  restrictToDeclared,
  ruleDeclarationProblem,
} from "../../src/lib/rule-actions";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const module_ = at("../../src/lib/rule-actions.ts");
const createDoor = at("../../src/app/api/enrichment-rules/route.ts");
const runDoor = at("../../src/app/api/enrichment-rules/[id]/route.ts");
const leadDoor = at("../../src/app/api/leads/[id]/route.ts");
const scheduler = at("../../src/lib/scheduler.ts");
const enrichment = at("../../src/lib/enrichment.ts");
const seed = at("../../prisma/seed.ts");

/** The slice of source starting at the first occurrence of `needle`. */
function around(text: string, needle: string, width: number): string {
  const i = text.indexOf(needle);
  assert.notEqual(i, -1, `${needle} must be present for this claim to mean anything`);
  return text.slice(i, i + width);
}

/** The message a declaration is refused with, or `null` when it is accepted. */
const refusal = (actions: unknown): string | null => actionsProblem(actions);

describe("the vocabulary is the row's own", () => {
  it("offers exactly the two things a rule can declare about itself", () => {
    assert.deepEqual([...ACTION_KEYS], ["fields", "schedule"]);
  });

  it("names the writable columns from the module that owns a write, not a copy", () => {
    const code = blankComments(module_);
    assert.match(code, /import \{ ENRICH_WRITABLE \} from "\.\/enrich-plan"/);
    // A second list of the same columns would be a second answer to "what may a visit
    // write", and only one of them could ever be the list the write plan consults.
    for (const column of ["linkedinUrl", "companySize", "intentSignals"]) {
      assert.ok(!code.includes(`"${column}"`), `the module spells ${column} out itself`);
    }
  });

  it("refuses a column no write knows, and names the ones it does", () => {
    const problem = refusal({ fields: ["industry", "zip"] }) ?? "";
    assert.match(problem, /"zip"/, "the bad name is quoted back");
    assert.ok(!/"industry"/.test(problem), "and the good one is not called out");
    for (const column of ENRICH_WRITABLE) assert.ok(problem.includes(column), `the refusal never mentions ${column}`);
  });

  it("normalizes to the two keys and nothing else", () => {
    assert.deepEqual(normalizeActions({ fields: ["Seniority", "seniority"], schedule: " 0  9 * * 1 " }), { fields: ["seniority"], schedule: "0 9 * * 1" });
    assert.deepEqual(normalizeActions({ enrich: ["seniority"] }), {}, "a key nothing performs is not stored, whatever got it past a caller");
    assert.deepEqual(normalizeActions(null), {});
  });
});

describe("actionsProblem: every shape a caller can write", () => {
  it("calls anything that says nothing ‘the rule declares nothing’", () => {
    for (const value of [undefined, null, {}]) {
      assert.equal(refusal(value), null, `${JSON.stringify(value)} declares nothing, which is the old behaviour`);
    }
  });

  it("refuses a blob that is not a set of declarations", () => {
    for (const value of [42, "email", true, ["email"]]) {
      const problem = refusal(value);
      assert.notEqual(problem, null, `${JSON.stringify(value)} is not an action`);
      assert.match(problem!, /fields, schedule/, "and the refusal says what is");
    }
  });

  it("refuses a key nothing performs, by name", () => {
    // Two spellings this fleet's own checked-in callers used for a column nothing read:
    // the seed's `fields`, which is the one kept, and `enrich`, which is not.
    assert.match(refusal({ enrich: ["seniority"] })!, /"enrich" is not something this build performs/);
    assert.match(refusal({ department: "Ops" })!, /"department"/);
    assert.match(refusal({ fields: ["email"], webhook: "https://x" })!, /"webhook"/);
  });

  it("accepts one word where a list is written, the way a single value is written elsewhere", () => {
    assert.equal(refusal({ fields: "seniority" }), null);
    assert.deepEqual(readRuleActions({ fields: " seniority " }), { fields: ["seniority"], schedule: null });
  });

  it("refuses a list of things that are not column names", () => {
    assert.match(refusal({ fields: ["email", 42] })!, /holds 42 among its values/);
    assert.match(refusal({ fields: ["email", "  "] })!, /holds "  " among its values/);
    assert.match(refusal({ fields: { a: 1 } })!, /must be a list of the columns to fill — it is an object/);
    assert.match(refusal({ fields: 7 })!, /must be a list of the columns to fill — it is 7/);
  });

  it("refuses an empty list rather than reading it as ‘anything’", () => {
    assert.match(refusal({ fields: [] })!, /fields: \[\] asks for no column at all/);
  });

  it("folds a word to the column's own spelling, folds repeats, keeps the caller's order", () => {
    // The names are camelCase and this fleet's own demo rule asks for `companySize`:
    // the first version of the reader folded to lowercase, and the door refused
    // `companysize` — a column it had just quoted in its own refusal.
    assert.deepEqual(
      readRuleActions({ fields: [" CompanySize ", "COMPANYSIZE", "linkedinUrl", "seniority"] }).fields,
      ["companySize", "linkedinUrl", "seniority"],
    );
    assert.equal(refusal({ fields: ["companySize"] }), null);
    assert.equal(refusal({ fields: ["COMPANYSIZE"] }), null, "a name typed the way a person types it means the column it names");
    assert.equal(refusal({ fields: ["seniority"] }), null);
  });

  it("reports every problem in one message, not the first", () => {
    const problem = refusal({ fields: ["zip"], enrich: [], schedule: "every day" })!;
    assert.match(problem, /"zip"/);
    assert.match(problem, /"enrich"/);
    assert.match(problem, /schedule/);
    assert.equal(problem.split("; ").length, 3, "three problems from one call");
  });
});

describe("the cadence is the five fields the matcher reads", () => {
  it("accepts what `shouldRunNow` can actually match", () => {
    for (const cron of ["* * * * *", "0 9 * * *", "30 8,12 * * 0,6", "0 9 * 1,6 1"]) {
      assert.equal(refusal({ schedule: cron }), null, `${cron} is matchable`);
    }
  });

  it("stores the cadence in the form the matcher splits on", () => {
    assert.equal(readRuleActions({ schedule: "  0   9 * * 1  " }).schedule, "0 9 * * 1");
  });

  it("refuses a field the matcher would never satisfy, and says why", () => {
    // `shouldRunNow` splits each field on "," and compares whole strings, so a step or a
    // range is not a coarser cadence — it is a rule that can never run.
    const step = refusal({ schedule: "*/5 * * * *" })!;
    assert.ok(step.includes('"*/5"'), `the offending field is quoted back, got: ${step}`);
    assert.match(step, /is not something this build's matcher reads/);
    assert.match(step, /minute must be/, "and the position it belongs to");
    assert.match(refusal({ schedule: "0 9 * * 1-5" })!, /day of week must be/);
    assert.match(refusal({ schedule: "0, 9 * * *" })!, /"0," has an empty entry/);
    assert.match(refusal({ schedule: "0 25 * * *" })!, /hour "25" holds 25, outside 0-23/);
    assert.match(refusal({ schedule: "60 * * * *" })!, /minute "60" holds 60, outside 0-59/);
    assert.match(refusal({ schedule: "0 9 0 * *" })!, /day of month "0" holds 0, outside 1-31/);
  });

  it("refuses a shape that is not five fields", () => {
    assert.match(refusal({ schedule: "* * * *" })!, /is 4 fields/);
    assert.match(refusal({ schedule: "0 0 9 * * *" })!, /is 6 fields/);
    assert.match(refusal({ schedule: "" })!, /is 1 fields/);
    assert.match(refusal({ schedule: ["* * * * *"] })!, /it is an array/);
    assert.match(refusal({ schedule: 5 })!, /it is 5/);
  });

  it("keeps an unreadable cadence out of the read-back too", () => {
    assert.equal(readRuleActions({ schedule: "*/5 * * * *" }).schedule, null);
    assert.deepEqual(readRuleActions({ fields: ["email"], schedule: "nope" }), { fields: ["email"], schedule: null });
  });
});

describe("the pairing the blob cannot state", () => {
  it("refuses a SCHEDULED rule with no cadence, because nothing would ever run it", () => {
    assert.match(ruleDeclarationProblem("SCHEDULED", { fields: ["seniority"] })!, /a SCHEDULED rule needs actions\.schedule/);
    assert.match(ruleDeclarationProblem("SCHEDULED", {})!, /needs actions\.schedule/);
    assert.match(ruleDeclarationProblem("SCHEDULED", { schedule: "*/5 * * * *" })!, /needs actions\.schedule/, "an unmatchable cadence is no cadence");
  });

  it("refuses a cadence on a trigger nothing sweeps", () => {
    assert.match(ruleDeclarationProblem("MANUAL", { schedule: "0 9 * * *" })!, /means nothing to a rule whose trigger is not SCHEDULED/);
    assert.match(ruleDeclarationProblem("ON_CREATE", { fields: ["email"], schedule: "0 9 * * *" })!, /not SCHEDULED/);
  });

  it("accepts the honest pairings", () => {
    assert.equal(ruleDeclarationProblem("SCHEDULED", { fields: ["seniority"], schedule: "0 9 * * 1" }), null);
    assert.equal(ruleDeclarationProblem("ON_CREATE", { fields: ["email"] }), null);
    assert.equal(ruleDeclarationProblem("MANUAL", null), null, "a rule that declares nothing is the rule it always was");
  });

  it("reports the blob's own problems beside the pairing's", () => {
    const problem = ruleDeclarationProblem("SCHEDULED", { enrich: ["seniority"] })!;
    assert.match(problem, /"enrich"/);
    assert.match(problem, /needs actions\.schedule/);
  });

  it("leaves the shipped seed acceptable to the shipped door", () => {
    // `prisma/seed.ts` writes its rule straight through Prisma, so a door that had since
    // tightened would leave the demo workspace holding a row it could never have created.
    const literal = around(seed, "actions: {", 200).match(/actions: (\{[^}]*\})/)![1].replace(/([a-z]+):/g, '"$1":');
    const declared = JSON.parse(literal) as { fields?: unknown };
    const trigger = /trigger: "([A-Z_]+)"/.exec(around(seed, "trigger:", 40))![1];
    const problem = ruleDeclarationProblem(trigger, declared);
    assert.equal(problem, null, `the seeded rule is refused: ${problem}`);
    assert.deepEqual(declared.fields, ["email", "phone", "title", "company", "technologies"]);
  });

  it("keeps the seeded rule's own declaration narrower than its name", () => {
    // "Auto-enrich new leads" declares five columns and no seniority: after this round a
    // visit for that rule cannot write a seniority, which is what the row says.
    assert.deepEqual(readRuleActions({ fields: ["email", "phone", "title", "company", "technologies"] }).fields, [
      "email", "phone", "title", "company", "technologies",
    ]);
  });
});

describe("what a declared list does to an answer", () => {
  it("leaves an undeclared job exactly the answer it had", () => {
    const answer = { seniority: "C_LEVEL", industry: "Real Estate" };
    assert.equal(restrictToDeclared(answer, []), answer, "an empty list is not a narrowing");
    assert.equal(restrictToDeclared(answer, null), answer);
    assert.equal(restrictToDeclared(answer, undefined), answer);
  });

  it("keeps only what was asked for, in the order the provider answered", () => {
    const answer = { seniority: "C_LEVEL", industry: "Real Estate", companySize: "11-50" };
    assert.deepEqual(restrictToDeclared(answer, ["industry", "seniority"]), { seniority: "C_LEVEL", industry: "Real Estate" });
  });

  it("cannot add a column a provider never answered", () => {
    assert.deepEqual(restrictToDeclared({ seniority: "VP" }, ["seniority", "email"]), { seniority: "VP" });
  });

  it("empties the answer when the rule asked for something else", () => {
    assert.deepEqual(restrictToDeclared({ seniority: "C_LEVEL" }, ["industry"]), {}, "the visit happened; it takes nothing");
  });
});

describe("the wiring, from the source", () => {
  it("refuses a bad declaration on both rule writes, before anything is stored", () => {
    for (const [where, text] of [["POST", createDoor], ["PATCH", runDoor]] as const) {
      const code = blankComments(text);
      assert.match(code, /ruleDeclarationProblem\(/, `${where} checks the pairing`);
      assert.match(code, /status: 400/, `${where} answers the caller`);
    }
    const created = blankComments(functionBody(createDoor, "POST_impl")!);
    assert.ok(created.indexOf("ruleDeclarationProblem") < created.indexOf("prisma.enrichmentRule.create"), "refused before the row exists");
    assert.match(created, /actions: asInputJson\(normalizeActions\(input\.data\.actions\)\)/, "and stored in the shape it was read as");
  });

  it("checks a PATCH against the half of the rule the request did not change", () => {
    const body = blankComments(functionBody(runDoor, "PATCH_impl")!);
    assert.match(body, /switched \?\? _owned\.trigger/, "the stored trigger when only the actions moved");
    assert.match(body, /performed \?\? _owned\.actions/, "the stored actions when only the trigger moved");
    assert.match(body, /select: \{ workspaceId: true, trigger: true, actions: true \}/, "and both are read before the write");
  });

  it("carries the declared columns into the job the run door queues", () => {
    const body = blankComments(functionBody(runDoor, "POST_impl")!);
    assert.match(body, /fields: performed\.fields \?\? \[\]/);
    assert.match(body, /rule cannot run: \$\{declarationProblem\}/, "an unreadable actions answers 400, not a job");
    assert.ok(!/leadIds/.test(around(body, 'type: "ENRICH"', 700)), "?action=run still names no crowd — the conditions do");
    assert.match(around(body, 'type: "ENRICH"', 700), /conditions: asInputJson\(stored\.conditions\)/);
  });

  it("stops reading the JSON column as a cron string, everywhere", () => {
    const code = blankComments(scheduler);
    assert.ok(!/typeof rule\.actions/.test(code), "the coercion that made every rule inert is gone");
    assert.equal(countCodeMentions(code, "rule-actions"), 1, "one import of the reader");
    const sweep = blankComments(functionBody(scheduler, "runScheduledJobs")!);
    assert.match(sweep, /shouldRunNow\(declared\.schedule \?\? "", now\)/);
    assert.match(sweep, /fields: declared\.fields \?\? \[\]/, "the minute carries the rule's own list");
    const warn = sweep.indexOf("console.warn(`Enrichment rule");
    assert.ok(warn > -1, "a junk blob is logged");
    assert.ok(sweep.indexOf("prisma.lead.findMany") > sweep.indexOf("continue;", warn), "and skipped before any lead is read");
  });

  it("has the sweep and the queue-side copy read the same declaration", () => {
    const copy = blankComments(functionBody(enrichment, "runScheduledEnrichment")!);
    assert.match(copy, /actionsProblem\(rule\.actions\)/);
    assert.match(copy, /fields: declared\.fields \?\? \[\]/);
    assert.ok(blankComments(enrichment).includes("readRuleActions"), "the worker file imports the reader");
  });

  it("narrows what a visit writes, after the visit is known to have happened", () => {
    const body = blankComments(functionBody(enrichment, "enrichLead")!);
    const answered = body.indexOf("if (answered === 0) return null;");
    assert.ok(answered > -1, "the nothing-answered rule is still first");
    assert.ok(body.indexOf("restrictToDeclared(results, config.fields)") > answered, "a provider that answered is narrowed, not skipped");
    assert.match(blankComments(enrichment), /from "\.\/rule-actions"/);
  });

  it("leaves the doors that declare no field list declaring none", () => {
    // The single-lead visit sends `fields: []`, which means "nothing was said about
    // columns" — the behaviour STEP 12 pins for one named lead, unchanged.
    assert.match(blankComments(leadDoor), /fields: \[\], confidenceThreshold: 0\.5, leadIds: \[id\]/);
    const bulk = blankComments(around(enrichment, 'type: "ENRICH"', 600));
    assert.match(bulk, /config: asInputJson\(\{ \.\.\.config, leadIds \}\)/, "and the bulk queue still carries what its caller handed it");
  });

  it("is the only module in src that decides what a cadence is", () => {
    const offenders: string[] = [];
    for (const [file, code] of [["scheduler.ts", scheduler], ["enrichment.ts", enrichment], ["create door", createDoor], ["run door", runDoor]] as const) {
      if (/shouldRunNow\(/.test(blankComments(code)) && !/declared\.schedule/.test(blankComments(code))) offenders.push(file);
    }
    assert.deepEqual(offenders, [], "a cadence reaches the matcher through the reader only");
  });
});
