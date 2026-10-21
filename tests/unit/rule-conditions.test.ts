// #28 — `EnrichmentRule.conditions` read as the promise its comment makes, pinned offline.
//
// `prisma/schema.prisma` declares `conditions Json // When to apply this rule`, and
// `RULE_CREATE` makes the column required: a rule cannot be created without saying when
// it applies. Nothing read it back. The three doors that pick leads carried their own
// `status: { in: ["NEW", "ENRICHED"] }`, so `{ status: "NEW" }` selected the same crowd as
// `{ status: "CONVERTED" }` and the seeded rule named "Auto-enrich new leads" did not mean
// its own name. `conditions: 42` was a 201 there for two hundred reasons at once —
// `src/lib/validate.ts` has the measured row.
//
// What this file pins, in the order the code runs:
//
//   1. the schema's own words — that a condition can only name a `Lead` column, and that
//      the vocabulary in every refusal message is the vocabulary `schema.prisma` spells;
//   2. the door's refusals, every problem at once, in the operator's terms;
//   3. what gets stored once a declaration is accepted;
//   4. what a door gets when it reads a stored row back, including the two rules that
//      keep the rewrite from widening: nothing declared keeps yesterday's selection, and
//      something unreadable selects nobody;
//   5. one translation: the `where` the scheduler queues and the predicate the worker
//      applies to the row in hand are built from the same declaration and cannot disagree;
//   6. the wiring itself, scanned from the source — that each door actually calls these
//      functions, in the right order, with the hardcoded set gone from the repository.
//
// The 12 live leads and the queue that enriches them are the demo's job (STEP 9); none of
// that needs a database to be wrong in the ways listed here, so none of it is asked for one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import {
  CONDITION_KEYS,
  DEFAULT_CONDITIONS,
  LEAD_SENIORITIES,
  conditionsProblem,
  describeConditions,
  leadMatches,
  leadWhere,
  normalizeConditions,
  readStoredConditions,
} from "../../src/lib/rule-conditions";
import * as FIELDS from "../../src/lib/fields";
import * as ENUMS from "../../src/lib/enums";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const ruleRoute = at("../../src/app/api/enrichment-rules/route.ts");
const ruleIdRoute = at("../../src/app/api/enrichment-rules/[id]/route.ts");
const scheduler = at("../../src/lib/scheduler.ts");
const enrichment = at("../../src/lib/enrichment.ts");
const module_ = at("../../src/lib/rule-conditions.ts");

/** The `Lead` model's own block, comment included. */
function leadBlock(): string {
  const m = /model Lead \{([\s\S]*?)\n\}/.exec(schema);
  assert.ok(m, "the schema must have a Lead model for these claims to mean anything");
  return m[1];
}

/** The words a `Lead` column's schema comment spells out, e.g. `NEW | ENRICHED | …`. */
function commentSet(column: string): string[] {
  const line = new RegExp(`^\\s*${column}\\s+\\S+.*//\\s*(.+)$`, "m").exec(leadBlock());
  assert.ok(line, `schema.prisma must comment the ${column} column`);
  return line[1].trim().split("|").map((w) => w.trim());
}

/** The first offset of a call in a body, so a test can speak about order. */
const first = (haystack: string, needle: string): number => {
  const i = haystack.indexOf(needle);
  assert.ok(i >= 0, `expected source to contain ${needle}`);
  return i;
};

/** The next `needle` after `from` — for a body that says `continue` more than once. */
const next = (haystack: string, needle: string, from: number): number => {
  const i = haystack.indexOf(needle, from);
  assert.ok(i >= 0, `expected source to contain ${needle} after offset ${from}`);
  return i;
};

/** The text around an anchor, for a claim about what sits inside one object literal. */
const around = (haystack: string, anchor: string, span: number): string => {
  const i = first(haystack, anchor);
  return haystack.slice(i, i + span);
};

describe("the promise the schema makes", () => {
  it("has a conditions column whose comment is the promise itself", () => {
    assert.match(schema, /model EnrichmentRule \{[\s\S]*?conditions\s+Json\s+\/\/ When to apply this rule/);
  });

  it("makes the column required at create, so a rule always declares when it applies", () => {
    assert.equal(FIELDS.RULE_CREATE.conditions.required, true);
    assert.equal("required" in FIELDS.RULE_PATCH.conditions, false);
  });

  it("lets only real Lead columns be spoken about", () => {
    for (const key of CONDITION_KEYS) {
      assert.match(leadBlock(), new RegExp(`^\\s*${key}\\s`, "m"), `${key} is not a column on Lead`);
    }
  });

  it("refuses a status in the words the status column spells", () => {
    assert.deepEqual(commentSet("status"), [...ENUMS.LEAD_STATUSES]);
    assert.match(conditionsProblem({ status: "DONE" })!, new RegExp(ENUMS.LEAD_STATUSES.join(" \\| ")));
  });

  it("refuses a seniority in the words the seniority column spells", () => {
    assert.deepEqual(commentSet("seniority"), [...LEAD_SENIORITIES]);
    assert.match(conditionsProblem({ seniority: "BOSS" })!, new RegExp(LEAD_SENIORITIES.join(" \\| ")));
  });

  it("keeps the score bounds it quotes inside the score column's own range", () => {
    assert.match(commentSet("score").join(" "), /0-100/);
    assert.match(conditionsProblem({ score: { gte: 9999 } })!, /the column is 0-100/);
  });

  it("names the supported keys in the refusal out of the same list the check uses", () => {
    const problem = conditionsProblem({ department: "Ops" })!;
    for (const key of CONDITION_KEYS) assert.ok(problem.includes(key), problem);
  });
});

describe("conditionsProblem: what the door refuses", () => {
  it("accepts a rule that declares nothing", () => {
    // `{}` and `null` were both storable and both selected the same crowd as every
    // other rule, because nothing read them. Saying nothing is still saying nothing.
    for (const absent of [undefined, null, {}]) {
      assert.equal(conditionsProblem(absent), null, JSON.stringify(absent));
    }
    assert.match(conditionsProblem("")!, /it is ""/);
  });

  it("refuses a blob that is not an object, naming what it found", () => {
    assert.match(conditionsProblem(42)!, /it is 42, which no lead can be/);
    assert.match(conditionsProblem("fifty-fifty")!, /it is "fifty-fifty"/);
    assert.match(conditionsProblem([{ status: "NEW" }])!, /it is an array/);
  });

  it("refuses a key that is not an attribute a lead has", () => {
    assert.match(conditionsProblem({ department: "Ops" })!, /"department" is not an attribute a rule can condition on/);
    // `department` is a Lead column and a legitimate thing to want; the answer says so
    // by naming the four that work today rather than pretending the wish is nonsense.
    assert.match(leadBlock(), /^\s*department\s/m);
  });

  it("refuses every status word the column does not hold", () => {
    for (const status of ENUMS.LEAD_STATUSES) {
      assert.equal(conditionsProblem({ status }), null, status);
    }
    // The refusal quotes the word after the fold the column uses, so what is on screen
    // is what the query would have compared.
    assert.match(conditionsProblem({ status: "new_lead" })!, /status names "NEW_LEAD"/);
    assert.match(conditionsProblem({ seniority: "boss" })!, /seniority names "BOSS"/);
  });

  it("refuses an empty list instead of reading it as no filter", () => {
    // `{status: []}` compiles to `status IN ()`, which is nobody; the operator who
    // meant "no status filter" has a key to drop, and is told that.
    assert.match(conditionsProblem({ status: [] })!, /status: \[\] asks for no lead at all — drop the key/);
    assert.match(conditionsProblem({ tags: [] })!, /tags: \[\] asks for no lead at all/);
  });

  it("refuses a value where a word belongs", () => {
    assert.match(conditionsProblem({ status: { in: ["NEW"] } })!, /status must be a value or a list of values — it is an object/);
    assert.match(conditionsProblem({ seniority: ["VP", 42] })!, /seniority holds 42 among its values — every entry must be a word/);
    assert.match(conditionsProblem({ tags: ["vip", ""] })!, /tags holds "" among its values/);
  });

  it("refuses a score that is not a range", () => {
    assert.equal(conditionsProblem({ score: { gte: 60, lte: 80 } }), null);
    assert.equal(conditionsProblem({ score: { gte: 60 } }), null);
    assert.equal(conditionsProblem({ score: { lte: 40 } }), null);
    assert.match(conditionsProblem({ score: 60 })!, /score must be an object of the bounds to apply — \{ gte, lte \} — it is 60/);
    assert.match(conditionsProblem({ score: {} })!, /score carries neither bound — drop the key/);
    assert.match(conditionsProblem({ score: { above: 5 } })!, /score carries "above" — only gte and lte mean anything/);
    assert.match(conditionsProblem({ score: { gte: 60.5 } })!, /score\.gte must be a whole number — it is 60\.5/);
    assert.match(conditionsProblem({ score: { gte: -1 } })!, /score\.gte is -1 and the column is 0-100/);
    assert.match(conditionsProblem({ score: { gte: 80, lte: 60 } })!, /score asks for at least 80 and at most 60 — no number is both/);
  });

  it("reports every problem in one answer, each with its key", async () => {
    const problem = conditionsProblem({ department: "Ops", status: "DONE", score: { gte: 900 }, region: "EU" })!;
    const parts = problem.split("; ");
    assert.equal(parts.length, 4, problem);
    assert.ok(problem.includes('"department"'), problem);
    assert.ok(problem.includes('"region"'), problem);
    assert.ok(problem.includes("status names"), problem);
    assert.ok(problem.includes("score.gte is 900"), problem);
  });

  it("still hands the shape complaints to the validation engine, unchanged", () => {
    // `kind: "json"` owns "is it JSON at all"; this owns "does it describe a lead".
    // A caller who sends `conditions: 42` gets the engine's message, and both are 400s.
    const shape = FIELDS.RULE_CREATE.conditions;
    assert.equal(shape.kind, "json");
    const shapeProblems = [42, "text"].map((v) => conditionsProblem(v));
    assert.ok(shapeProblems.every((p) => p !== null));
  });
});

describe("normalizeConditions: what the row stores", () => {
  it("turns one value into the list the column holds", () => {
    assert.deepEqual(normalizeConditions({ status: "NEW" }), { status: ["NEW"] });
    assert.deepEqual(normalizeConditions({ status: "new" }), { status: ["NEW"] });
    assert.deepEqual(normalizeConditions({ seniority: ["vp", "c_level"] }), { seniority: ["VP", "C_LEVEL"] });
  });

  it("trims and dedupes without reordering what the operator wrote", () => {
    assert.deepEqual(normalizeConditions({ status: ["NEW", " new ", "ENRICHED"] }), { status: ["NEW", "ENRICHED"] });
  });

  it("keeps a tag exactly as written, because the SQL comparison does", () => {
    // Measured against the live workspace, whose seeded leads carry `["vip", "dubai"]`:
    // `array_contains` with `vip` returned 2 rows and with `VIP` returned 0. Folding the
    // case here would make the stored rule mean something the query cannot do.
    assert.deepEqual(normalizeConditions({ tags: ["High-Intent", "vip"] }), { tags: ["High-Intent", "vip"] });
    assert.deepEqual(normalizeConditions({ tags: "vip" }), { tags: ["vip"] });
  });

  it("keeps the score bounds and drops everything else", () => {
    assert.deepEqual(normalizeConditions({ score: { gte: 60, lte: 80 } }), { score: { gte: 60, lte: 80 } });
    assert.deepEqual(normalizeConditions({ score: { gte: 0, lte: 100 } }), { score: { gte: 0, lte: 100 } });
  });

  it("stores nothing it could not read", () => {
    assert.deepEqual(normalizeConditions(42), {});
    assert.deepEqual(normalizeConditions({ department: "Ops" }), {});
    assert.deepEqual(normalizeConditions({ status: "DONE" }), {});
    assert.deepEqual(normalizeConditions({ seniority: ["VP", "BOSS"] }), { seniority: ["VP"] });
    assert.deepEqual(normalizeConditions({ score: { gte: 900 } }), {});
    assert.deepEqual(normalizeConditions({ score: { gte: 80, lte: 60 } }), {});
    // The doors refuse these blobs outright; this is the backstop that keeps a value no
    // `Lead` row can carry out of the stored rule, where it would read as a declaration
    // that silently selects nobody forever.
  });
});

describe("readStoredConditions: what a door gets", () => {
  it("keeps the old selection for a rule that declares nothing", () => {
    // The rewrite cannot widen what a row that never mentioned a condition receives:
    // `NEW | ENRICHED` is what both hardcoded doors took, and `declared: false` is how
    // a log says "this rule never said".
    for (const absent of [undefined, null, {}]) {
      const read = readStoredConditions(absent);
      assert.deepEqual(read.conditions, { status: ["NEW", "ENRICHED"] }, JSON.stringify(absent));
      assert.equal(read.problem, null);
      assert.equal(read.declared, false);
    }
    assert.deepEqual(DEFAULT_CONDITIONS.status, [...ENUMS.LEAD_STATUSES.slice(0, 2)]);
    // A string in the column is not "nothing declared", it is something unreadable.
    assert.ok(readStoredConditions("NEW").problem !== null);
  });

  it("gives a stored rule the crowd it named", () => {
    const read = readStoredConditions({ status: "NEW" });
    assert.deepEqual(read.conditions, { status: ["NEW"] });
    assert.equal(read.declared, true);
    assert.equal(read.problem, null);
  });

  it("selects nobody on a blob it cannot read, and says why", () => {
    const read = readStoredConditions(42);
    assert.equal(read.problem, conditionsProblem(42));
    assert.equal(read.declared, false);
    assert.deepEqual(read.conditions, {});
    // `{}` here means "nothing could be read", NOT "no conditions" — which is why every
    // caller of this function is required to look at `problem` first. That requirement is
    // the wiring guard at the end of this file, not a comment.
  });

  it("reads back a normalized blob the same way it reads the declaration", () => {
    const stored = normalizeConditions({ status: "new", tags: ["vip"], score: { gte: 50 } });
    assert.deepEqual(readStoredConditions(stored).conditions, stored);
  });
});

describe("leadMatches: the declaration applied to a row", () => {
  const lead = { status: "NEW", seniority: "VP", score: 71, tags: ["vip", "dubai"] };

  it("requires every key it was given, and any one of a key's values", () => {
    assert.equal(leadMatches({ status: ["NEW"], seniority: ["VP"] }, lead), true);
    assert.equal(leadMatches({ status: ["NEW", "ENRICHED"], seniority: ["IC", "VP"] }, lead), true);
    assert.equal(leadMatches({ status: ["NEW"], seniority: ["IC"] }, lead), false);
    assert.equal(leadMatches({ status: ["ENRICHED"], seniority: ["VP"] }, lead), false);
  });

  it("fails a lead that does not have the attribute the rule names", () => {
    assert.equal(leadMatches({ status: ["NEW"] }, { seniority: "VP" }), false);
    assert.equal(leadMatches({ seniority: ["VP"] }, { status: "NEW" }), false);
    assert.equal(leadMatches({ score: { gte: 10 } }, { status: "NEW", score: null }), false);
    assert.equal(leadMatches({ tags: ["vip"] }, { status: "NEW" }), false);
  });

  it("takes the score range at both bounds", () => {
    assert.equal(leadMatches({ score: { gte: 71, lte: 71 } }, lead), true);
    assert.equal(leadMatches({ score: { gte: 72 } }, lead), false);
    assert.equal(leadMatches({ score: { lte: 70 } }, lead), false);
  });

  it("matches a tag exactly, and accepts the JSON string a Json column can hold", () => {
    assert.equal(leadMatches({ tags: ["vip"] }, lead), true);
    assert.equal(leadMatches({ tags: ["dubai", "nowhere"] }, lead), true);
    assert.equal(leadMatches({ tags: ["VIP"] }, lead), false);
    assert.equal(leadMatches({ tags: ["investor"] }, lead), false);
    assert.equal(leadMatches({ tags: ["vip"] }, { status: "NEW", tags: '["vip", "dubai"]' }), true);
    assert.equal(leadMatches({ tags: ["vip"] }, { status: "NEW", tags: "not json at all" }), false);
  });

  it("compares an enum the way the SQL list does, character for character", () => {
    // The lead routes validate `status` against `LEAD_STATUSES` exactly, so a stored
    // lowercase row is not something the app can make; folding here would be the one
    // place the in-memory reading and the query disagreed.
    assert.equal(leadMatches({ status: ["NEW"] }, { status: "new" }), false);
    assert.equal(leadWhere("ws", { status: ["NEW"] }) !== null, true);
  });

  it("matches every lead when given nothing — which is why {} needs a guard", () => {
    assert.equal(leadMatches({}, { status: "CONVERTED" }), true);
    assert.equal(leadMatches({}, {}), true);
  });
});

describe("one translation, both doors", () => {
  const ws = "ws-1";

  it("always scopes the query to the caller's workspace", () => {
    for (const conditions of [{}, DEFAULT_CONDITIONS, { tags: ["vip"] }, { score: { gte: 5 } }]) {
      const where = leadWhere(ws, conditions) as any;
      assert.equal(where.AND[0].workspaceId, ws);
    }
  });

  it("compiles the set the hardcoded doors used to carry", () => {
    assert.deepEqual(leadWhere(ws, DEFAULT_CONDITIONS), {
      AND: [{ workspaceId: ws }, { status: { in: ["NEW", "ENRICHED"] } }],
    });
  });

  it("compiles each attribute into the column's own operator", () => {
    assert.deepEqual(leadWhere(ws, { status: ["NEW"] }), { AND: [{ workspaceId: ws }, { status: { in: ["NEW"] } }] });
    assert.deepEqual(leadWhere(ws, { seniority: ["VP", "C_LEVEL"] }), {
      AND: [{ workspaceId: ws }, { seniority: { in: ["VP", "C_LEVEL"] } }],
    });
    assert.deepEqual(leadWhere(ws, { score: { gte: 60 } }), { AND: [{ workspaceId: ws }, { score: { gte: 60 } }] });
    assert.deepEqual(leadWhere(ws, { score: { gte: 60, lte: 80 } }), {
      AND: [{ workspaceId: ws }, { score: { gte: 60, lte: 80 } }],
    });
  });

  it("asks a tags array for any one of its values, in the case it was written", () => {
    const where = leadWhere(ws, { tags: ["vip", "High-Intent"] }) as any;
    assert.deepEqual(where.AND[1], {
      OR: [{ tags: { array_contains: "vip" } }, { tags: { array_contains: "High-Intent" } }],
    });
  });

  it("says the same thing as the predicate for the same declaration", () => {
    // The pair of readings this file keeps honest: whatever `leadWhere` would fetch,
    // `leadMatches` must accept, and whatever it would skip, `leadMatches` must reject.
    // A `where` with no term for a key the predicate checks would be a silent widening.
    const table: Array<[any, any, boolean]> = [
      [{ status: ["NEW"] }, { status: "NEW" }, true],
      [{ status: ["NEW"] }, { status: "CONVERTED" }, false],
      [{ seniority: ["VP"] }, { seniority: "VP" }, true],
      [{ seniority: ["VP"] }, { seniority: "IC" }, false],
      [{ seniority: ["VP"] }, { seniority: null }, false],
      [{ score: { gte: 60, lte: 80 } }, { score: 70 }, true],
      [{ score: { gte: 60, lte: 80 } }, { score: 81 }, false],
      [{ tags: ["vip"] }, { tags: ["vip", "dubai"] }, true],
      [{ tags: ["vip"] }, { tags: ["dubai"] }, false],
      [DEFAULT_CONDITIONS, { status: "ENRICHED" }, true],
      [DEFAULT_CONDITIONS, { status: "CONTACTED" }, false],
    ];
    for (const [conditions, lead, expected] of table) {
      const and = (leadWhere(ws, conditions) as any).AND;
      assert.equal(leadMatches(conditions, lead), expected, JSON.stringify(conditions));
      // Every key the predicate consults has a term in the query, so the two readings
      // cannot be looking at different columns. `tags` answers through an `OR` of
      // `array_contains`, which is the one term that does not put the key on itself.
      for (const key of Object.keys(conditions)) {
        const covered = and.some((term: any) => key in term || (Array.isArray(term.OR) && term.OR.some((alt: any) => key in alt)));
        assert.ok(covered, `${key} has no term in ${JSON.stringify(and)}`);
      }
    }
  });

  it("says a rule's promise out loud, in the words a log or a caller can read", () => {
    assert.equal(describeConditions(DEFAULT_CONDITIONS), "status NEW or ENRICHED");
    assert.equal(describeConditions({ status: ["NEW"], seniority: ["VP"], score: { gte: 60 }, tags: ["vip"] }),
      "status NEW, seniority VP, score >= 60, tagged vip");
    assert.equal(describeConditions({ score: { gte: 60, lte: 80 } }), "score >= 60 and <= 80");
    assert.match(describeConditions({}), /no conditions/);
  });
});

describe("the doors are wired, and the hardcoded set is gone", () => {
  it("refuses a declaration at create, before the row exists", () => {
    const body = functionBody(ruleRoute, "POST_impl")!;
    assert.ok(first(body, "validateBody") < first(body, "conditionsProblem"), "shape first, meaning second");
    assert.ok(first(body, "conditionsProblem") < first(body, "prisma.enrichmentRule.create"));
    assert.match(body, /conditionsProblem\(input\.data\.conditions\)/);
    assert.match(body, /\{ status: 400 \}/);
    // The stored blob is the normalized one, so a reader never has to fold cases.
    assert.ok(first(body, "conditionsProblem") < first(body, "normalizeConditions"));
    assert.match(body, /conditions: asInputJson\(normalizeConditions\(input\.data\.conditions\)\)/);
  });

  it("refuses a redeclaration on patch, and leaves a patch that says nothing alone", () => {
    const body = functionBody(ruleIdRoute, "PATCH_impl")!;
    assert.ok(first(body, "conditionsProblem") < first(body, "prisma.enrichmentRule.update"));
    // `if (declared !== undefined)` — a PATCH that never names conditions must not be
    // judged on a declaration it did not send, and must not rewrite the column either.
    assert.match(body, /const declared = input\.data\.conditions;\s*if \(declared !== undefined\)/);
    assert.match(body, /declared === undefined\s*\?\s*input\.data/);
  });

  it("refuses to run a rule whose conditions cannot be read, instead of queueing it", () => {
    const body = functionBody(ruleIdRoute, "POST_impl")!;
    assert.ok(first(body, "readStoredConditions") < first(body, "prisma.job.create"));
    assert.ok(first(body, "stored.problem !== null") < first(body, "prisma.job.create"));
    assert.match(body, /conditions: asInputJson\(stored\.conditions\)/);
    // What the run will apply, in the answer: the caller asked a rule to fire and is
    // told which leads that meant.
    assert.match(body, /appliesTo: describeConditions\(stored\.conditions\)/);
  });

  it("queues the schedule with the rule's own conditions in the job", () => {
    const body = functionBody(scheduler, "runScheduledJobs")!;
    assert.match(body, /readStoredConditions\(rule\.conditions\)/);
    assert.match(body, /where: leadWhere\(rule\.workspaceId, stored\.conditions\)/);
    assert.match(body, /conditions: asInputJson\(stored\.conditions\)/);
    // Skip and log, before anything is written: no job row, no queue entry, no lead.
    const warn = first(body, 'console.warn(`Enrichment rule');
    assert.ok(next(body, "continue;", warn) < first(body, "prisma.lead.findMany"));
  });

  it("selects in the worker from the job's config, and re-checks the row it will write", () => {
    const body = functionBody(enrichment, "getLeadsToEnrich")!;
    assert.match(body, /readStoredConditions\(config\.conditions\)/);
    assert.match(body, /where: leadWhere\(workspaceId, stored\.conditions\)/);
    assert.match(body, /leads\.filter\(\(lead\) => leadMatches\(stored\.conditions, lead\)\)/);
    assert.ok(first(body, "return []") < first(body, "leadWhere"), "an unreadable blob never reaches the query");
  });

  it("wires the third door too, so the rule holds repository-wide", () => {
    const body = functionBody(enrichment, "runScheduledEnrichment")!;
    assert.match(body, /readStoredConditions\(rule\.conditions\)/);
    assert.match(body, /where: leadWhere\(rule\.workspaceId, stored\.conditions\)/);
    assert.match(body, /conditions: stored\.conditions/);
    const warn = first(body, 'console.warn(`Enrichment rule');
    assert.ok(next(body, "continue;", warn) < first(body, "prisma.lead.findMany"));
  });

  it("carries the conditions through the queue into the job config", () => {
    // `scheduler.ts` and `?action=run` both write `conditions` into `config`; the
    // worker reads `config.conditions`. If either door stopped carrying it, every rule
    // would go back to enriching `NEW | ENRICHED` and the tests above would still pass.
    for (const [where, text] of [["scheduler.ts", scheduler], ["?action=run", ruleIdRoute]] as const) {
      assert.match(around(text, 'type: "ENRICH"', 400), /conditions: asInputJson\(stored\.conditions\)/, where);
    }
  });

  it("has no hardcoded enrichment status set left anywhere in src", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith(".ts")) {
          if (blankComments(readFileSync(p, "utf8")).includes('status: { in: ["NEW", "ENRICHED"] }')) offenders.push(p);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    assert.deepEqual(offenders, [], `a door is still choosing leads by itself: ${offenders.join(", ")}`);
  });

  it("keeps the vocabulary in the module docblock true of the schema", () => {
    // The docblock is what a reader of `rule-conditions.ts` starts with, and it names
    // three doors. A fourth one added later has to be written into it, or the sentence
    // becomes the one thing in this file that is allowed to be a lie.
    const doors = ["scheduler.ts", "getLeadsToEnrich", "runScheduledEnrichment"];
    for (const door of doors) assert.ok(module_.includes(door), `the docblock never names ${door}`);
    assert.match(module_, /The three doors/);
  });
});
