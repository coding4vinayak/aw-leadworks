// #30 — `Lead.score`, which nothing ever computed, and the one module that owns it now.
//
// Measured before this round: the schema comment promises "Lead score 0-100", the
// dashboard's shortlist and `GET /api/leads` both order by it, and `ai-score.ts` opens
// by explaining "a score that already exists". Nothing produced one. Intake and the CSV
// importer left the column at its default 0 — the demo's three imported contacts sat at
// `score=0` with an email, a company, a title, a location, a country and an industry —
// and the only automatic writer was the VALIDATE worker's
// `score: Math.max(0, lead.score - failedChecks.length * 10)`, a subtraction from whatever
// number the column happened to hold, so the same three failed checks knocked the score
// down again on every run, always from 0. `POST /api/ai/explain-lead` told a caller with
// no LLM key that "the deterministic score is unaffected and still returned" about a score
// that was not deterministic.
//
// What this file pins, in the order the code runs:
//
//   1. the table, in the schema's own words — every term is a `Lead` column, the terms sum
//      to exactly 100 so "0-100" is arithmetic rather than a clamp, and the three columns
//      the module owns exist and are declared nowhere a caller can type into;
//   2. what a row earns — known answers, the `UNKNOWN` rung, the blank string, the value
//      whose shape the column cannot hold, and that the score is never an input to itself;
//   3. a person's number — the override, including the 0 that a `??` would have thrown
//      away, and that both numbers stay visible in the ledger;
//   4. the penalty rule — priced from the checks the validator recorded, floored at 0,
//      unmoved by anything that is not a recorded failure, and idempotent;
//   5. the ledger read back — round-tripped through JSON, and what a reader refuses;
//   6. the writers, scanned from the source — seven of them, one helper, no second
//      arithmetic anywhere else in the app.
//
// The live proof is `demo/run-demo.sh leadworks` STEP 11. None of the ways this used to be
// wrong needs a database to be wrong about, so none of these tests asks for one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blankComments, countCodeMentions, functionBody } from "./route-handlers";
import { LEAD_CREATE, LEAD_PATCH } from "../../src/lib/fields";
import { ENRICH_WRITABLE } from "../../src/lib/enrich-plan";
import { crowdWhere, namedLeads } from "../../src/lib/lead-crowd";
import {
  SCORE_COLUMNS,
  SCORE_TERMS,
  VALIDATION_PENALTY_PER_FAILED_CHECK,
  computeLeadScore,
  readScoreLedger,
  rowAfterWrite,
  scoredWriteData,
  type ScoreableLead,
} from "../../src/lib/lead-score";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const migration = at("../../prisma/migrations/20261021120000_lead_score_owner/migration.sql");
const fields = at("../../src/lib/fields.ts");
const module_ = at("../../src/lib/lead-score.ts");
const createRoute = at("../../src/app/api/leads/route.ts");
const patchRoute = at("../../src/app/api/leads/[id]/route.ts");
const csvImport = at("../../src/lib/csv-import.ts");
const scraper = at("../../src/lib/scraper.ts");
const validator = at("../../src/lib/validator.ts");
const dedupe = at("../../src/lib/dedupe.ts");
const enrichPlan = at("../../src/lib/enrich-plan.ts");
const explainRoute = at("../../src/app/api/ai/explain-lead/route.ts");
const dashboard = at("../../src/app/dashboard/page.tsx");

/** The `Lead` model's own block, comment included. */
function leadBlock(): string {
  const m = /model Lead \{([\s\S]*?)\n\}/.exec(schema);
  assert.ok(m, "the schema must have a Lead model for these claims to mean anything");
  return m[1];
}

/** Every scalar column `Lead` declares — the schema, not a copy of it in this file. */
function leadColumns(): Set<string> {
  const out = new Set<string>();
  for (const raw of leadBlock().split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^(\w+)\s+([A-Za-z]\w*)([?]|(\[\]))?(\s|$)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Every `.ts` under `src`, the generated client excluded. */
function appSources(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "generated" || entry === ".next") continue;
        walk(path);
      } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        found.set(path.slice(path.indexOf("/src/")), readFileSync(path, "utf8"));
      }
    }
  };
  walk(join(process.cwd(), "src"));
  return found;
}

/** A row with nothing known but the fields the buyer's list arrived with. */
function imported(over: Record<string, unknown> = {}): ScoreableLead {
  return {
    email: "meera@northwind.test",
    company: "Northwind",
    title: "Director of Demand Generation",
    location: "Bengaluru",
    country: "IN",
    industry: "B2B SaaS",
    tags: ["vip"],
    ...over,
  } as ScoreableLead;
}

/** Every signal the table reads, present and well-shaped. */
function completeRow(): Record<string, unknown> {
  return {
    email: "meera@northwind.test",
    phone: "+919820000000",
    linkedinUrl: "https://linkedin.com/in/meera",
    firstName: "Meera",
    lastName: "Raghavan",
    title: "VP Demand Generation",
    company: "Northwind",
    seniority: "VP",
    department: "Marketing",
    location: "Bengaluru",
    country: "IN",
    industry: "B2B SaaS",
    companySize: "51-200",
    revenue: "$10M-$50M",
    technologies: ["React", "Postgres"],
    intentSignals: ["hiring a data engineer"],
    sourceId: "src_1",
  };
}

describe("the table, in the schema's own words", () => {
  it("reads the Lead model out of the schema", () => {
    // The scan itself, asserted before anything that trusts it.
    assert.ok(leadColumns().has("score") && leadColumns().has("scoreOverride"));
    assert.ok(leadColumns().size > 25, `measured ${leadColumns().size} columns`);
  });

  it("names only real Lead columns", () => {
    const columns = leadColumns();
    for (const term of SCORE_TERMS) {
      assert.ok(columns.has(term.column), `${term.column} is not a column on Lead`);
    }
  });

  it("sums to exactly 100, so the range is arithmetic and not a clamp", () => {
    const total = SCORE_TERMS.reduce((sum, term) => sum + term.points, 0);
    assert.equal(total, 100);
    assert.ok(!module_.includes("Math.min(100"), "no ceiling clamp");
    assert.ok(module_.includes("Math.max(0"), "one floor, for the penalty");
  });

  it("prices each signal once", () => {
    const seen = new Set<string>();
    for (const term of SCORE_TERMS) {
      assert.ok(!seen.has(term.column), `${term.column} is priced twice`);
      seen.add(term.column);
      assert.ok(term.points > 0, `${term.column} earns nothing and so does not belong in the table`);
      assert.ok(term.why.length > 8, `${term.column} has no sentence a buyer can read`);
    }
  });

  it("groups the signals into the five parts a gap can be in", () => {
    const groups = [...new Set(SCORE_TERMS.map((term) => term.group))].sort();
    assert.deepEqual(groups, ["contact", "firm", "identity", "intent", "provenance"]);
    // And the group totals the docblock claims.
    const byGroup = (group: string) =>
      SCORE_TERMS.filter((term) => term.group === group).reduce((sum, term) => sum + term.points, 0);
    assert.deepEqual(
      [byGroup("contact"), byGroup("identity"), byGroup("firm"), byGroup("intent"), byGroup("provenance")],
      [30, 16, 36, 14, 4],
    );
  });

  it("derives SCORE_COLUMNS from the table rather than copying it", () => {
    assert.deepEqual([...SCORE_COLUMNS], SCORE_TERMS.map((term) => term.column));
  });

  it("declares the three columns it owns, and migrates exactly those", () => {
    const block = leadBlock();
    assert.match(block, /score\s+Int\s+@default\(0\)/);
    assert.match(block, /scoreOverride\s+Int\?/);
    assert.match(block, /scoreBreakdown\s+Json\?/);
    assert.match(block, /scoredAt\s+DateTime\?/);
    assert.match(block, /\/\/ Lead score 0-100, computed by lib\/lead-score\.ts/);
    for (const column of ["scoreOverride", "scoreBreakdown", "scoredAt"]) {
      assert.ok(migration.includes(`"${column}"`), `${column} is not in the migration`);
    }
    assert.equal((migration.match(/ADD COLUMN/g) ?? []).length, 3, "the migration adds nothing else");
  });

  it("takes no score at the create door, and no ledger column at any door", () => {
    assert.ok(!("score" in LEAD_CREATE), "a caller states what they know, not what it is worth");
    assert.ok(!("scoreOverride" in LEAD_CREATE) && !("scoreBreakdown" in LEAD_CREATE));
    assert.ok(!("scoreOverride" in LEAD_PATCH) && !("scoredAt" in LEAD_PATCH));
    // `fields.ts` is where every door's table is declared, and no table in it names
    // these columns: the only way into an override is this round's PATCH, and there
    // is no way into the ledger or the stamp at all.
    const declared = blankComments(fields).match(/^\s*\w+: \{ kind: "/gm) ?? [];
    for (const column of ["scoreOverride", "scoreBreakdown", "scoredAt"]) {
      assert.ok(!declared.some((rule) => rule.trim().startsWith(`${column}:`)), `${column} is a door field`);
    }
    // And nothing reads one out of a request.
    for (const [path, src] of appSources()) {
      if (path.endsWith("lead-score.ts")) continue;
      const code = blankComments(src);
      for (const column of ["scoreOverride", "scoreBreakdown", "scoredAt"]) {
        assert.ok(!new RegExp(`(body|searchParams|raw\.body|params)\.${column}`).test(code), `${path} reads ${column} from a request`);
      }
    }
  });

  it("bounds a person's number at the door and nowhere else", () => {
    assert.deepEqual(LEAD_PATCH.score, { kind: "int", min: 0, max: 100, nullable: true });
    assert.equal(fields.includes("scoreOverride: {"), false, "the override is not a field a caller names");
  });
});

describe("what a row earns", () => {
  it("gives nothing to a row that says nothing", () => {
    const { score, breakdown } = computeLeadScore({});
    assert.equal(score, 0);
    assert.equal(breakdown.computed, 0);
    assert.deepEqual(breakdown.earned, []);
    assert.deepEqual(breakdown.gaps, ["contact", "identity", "firm", "intent", "provenance"]);
    assert.equal(breakdown.missing.length, SCORE_TERMS.length);
  });

  it("gives everything to a row that says everything", () => {
    const { score, breakdown } = computeLeadScore(completeRow() as ScoreableLead);
    assert.equal(score, 100);
    assert.deepEqual(breakdown.missing, []);
    assert.deepEqual(breakdown.gaps, []);
    assert.equal(breakdown.earned.length, SCORE_TERMS.length);
  });

  it("scores the imported contact the demo hands over, term for term", () => {
    const { score, breakdown } = computeLeadScore(imported());
    // email 15 + company 10 + title 6 + location 3 + country 3 + industry 4
    assert.equal(score, 41);
    assert.deepEqual(breakdown.earned.map((term) => term.column), ["email", "title", "company", "location", "country", "industry"]);
    assert.ok(breakdown.missing.includes("technologies"));
  });

  it("does not read a tag as a signal", () => {
    assert.ok(!SCORE_COLUMNS.includes("tags"));
    assert.equal(computeLeadScore(imported({ tags: null })).score, 41);
    assert.equal(computeLeadScore(imported({ tags: ["vip", "aim"] })).score, 41);
  });

  it("does not read the sales process as a signal", () => {
    for (const column of ["status", "lastContactedAt", "lastEnrichedAt"]) {
      assert.ok(!SCORE_COLUMNS.includes(column), `${column} is not a signal about the data`);
    }
    assert.equal(computeLeadScore(imported({ status: "CONVERTED" }) as ScoreableLead).score, 41);
  });

  it("does not read a reference it cannot follow as provenance", () => {
    assert.ok(!SCORE_COLUMNS.includes("sourceRef"));
    assert.equal(computeLeadScore(imported({ sourceRef: "apollo-export-7" })).score, 41);
    assert.equal(computeLeadScore(imported({ sourceId: "src_1" })).score, 45);
  });

  it("earns for the `UNKNOWN` rung nothing at all", () => {
    const unknown = computeLeadScore(imported({ seniority: "UNKNOWN" }));
    const asked = computeLeadScore(imported({ seniority: "IC" }));
    const typed = computeLeadScore(imported({ seniority: "C_LEVEL" }));
    assert.equal(unknown.score, 41);
    assert.ok(unknown.breakdown.missing.includes("seniority"));
    assert.equal(asked.score, 47, "knowing where they sit is the signal, not sitting high");
    assert.equal(typed.score, 47, "and a VP is worth the same as an IC");
    assert.equal(computeLeadScore(imported({ seniority: "manager" })).score, 41, "the word must be the schema's");
  });

  it("earns nothing for whitespace", () => {
    assert.equal(computeLeadScore({ email: "  ", company: "", title: "\t" }).score, 0);
    assert.equal(computeLeadScore(imported({ seniority: " " })).score, 41);
  });

  it("earns nothing for a list column that holds no list of words", () => {
    const bare = computeLeadScore(imported({ technologies: "React" as unknown as string[] }));
    const empty = computeLeadScore(imported({ technologies: [] }));
    const blank = computeLeadScore(imported({ technologies: ["React", "  "] }));
    const real = computeLeadScore(imported({ technologies: ["React", "Postgres"] }));
    assert.equal(bare.score, 41);
    assert.equal(empty.score, 41);
    assert.equal(blank.score, 41, "one blank entry makes the whole list not a list of words");
    assert.equal(real.score, 47);
  });

  it("is the same number for the same row, twice", () => {
    const row = completeRow() as ScoreableLead;
    assert.deepEqual(computeLeadScore(row), computeLeadScore(row));
  });

  it("never reads the score it is writing", () => {
    // The decay this round replaces: the worker fed the column back into itself, so
    // the same three failed checks knocked the number down once per run.
    const row = imported({ validationResults: [{ check: "phone_format", valid: false }] });
    const first = computeLeadScore(row);
    const again = computeLeadScore({ ...row, score: first.score } as ScoreableLead);
    assert.equal(first.score, 31);
    assert.equal(again.score, 31, "the number a run stamped is not an input to the next");
    assert.doesNotMatch(blankComments(module_).replace(/\s+/g, " "), /lead\.score(?!Override|Breakdown|edAt)/, "the module reads no score");
  });
});

describe("a person's number", () => {
  it("follows the override and keeps showing what the row earns", () => {
    const { score, breakdown } = computeLeadScore(imported({ scoreOverride: 82 }));
    assert.equal(score, 82);
    assert.equal(breakdown.basis, "override");
    assert.equal(breakdown.computed, 41);
    assert.equal(breakdown.override, 82);
    assert.equal(breakdown.base, 82);
    assert.equal(breakdown.earned.length, 6, "the terms are still listed, not replaced");
  });

  it("honours an override of 0, which a falsy check would have thrown away", () => {
    const { score, breakdown } = computeLeadScore(imported({ scoreOverride: 0 }));
    assert.equal(score, 0);
    assert.equal(breakdown.basis, "override");
    assert.equal(breakdown.override, 0);
    assert.equal(breakdown.computed, 41);
  });

  it("computes from the signals when nobody set one", () => {
    assert.equal(computeLeadScore(imported({ scoreOverride: null })).breakdown.basis, "signals");
    assert.equal(computeLeadScore(imported({ scoreOverride: undefined })).breakdown.basis, "signals");
    assert.equal(computeLeadScore(imported({ scoreOverride: null })).score, 41);
  });

  it("ignores an override that is not a number", () => {
    const { score, breakdown } = computeLeadScore(imported({ scoreOverride: "82" as unknown as number }));
    assert.equal(score, 41);
    assert.equal(breakdown.basis, "signals");
    assert.equal(breakdown.override, null);
  });

  it("can be given back", () => {
    const typed = computeLeadScore(imported({ scoreOverride: 82 }));
    const returned = computeLeadScore(rowAfterWrite(imported({ scoreOverride: 82 }) as Record<string, unknown>, { scoreOverride: null }));
    assert.equal(typed.score, 82);
    assert.equal(returned.score, 41);
    assert.equal(returned.breakdown.basis, "signals");
  });
});

describe("the penalty a recorded check costs", () => {
  it("prices every recorded failure by the declared rule", () => {
    assert.equal(VALIDATION_PENALTY_PER_FAILED_CHECK, 10);
    const results = [
      { check: "email_format", valid: true },
      { check: "phone_format", valid: false },
      { check: "linkedin_format", valid: false },
      { check: "domain_valid", valid: false },
    ];
    const { score, breakdown } = computeLeadScore(imported({ validationResults: results }));
    assert.equal(breakdown.penalty, -30);
    assert.equal(score, 11);
    assert.equal(breakdown.failedChecks.length, 3);
    assert.deepEqual(breakdown.failedChecks.map((entry) => entry.check), ["phone_format", "linkedin_format", "domain_valid"]);
  });

  it("floors at 0 rather than naming a negative score", () => {
    const results = Array.from({ length: 20 }, (_unused, index) => ({ check: `check_${index}`, valid: false }));
    const { score, breakdown } = computeLeadScore(imported({ validationResults: results }));
    assert.equal(breakdown.penalty, -200);
    assert.equal(score, 0);
  });

  it("counts only what the validator recorded as a failure", () => {
    const shapes = [
      [{ check: "x", valid: true }],
      [{ check: "x", valid: "false" }],
      [{ check: "x" }],
      [{ valid: false }],
      [null, "phone_format", 7],
    ];
    for (const validationResults of shapes) {
      const { score, breakdown } = computeLeadScore(imported({ validationResults: validationResults as unknown }));
      assert.equal(breakdown.penalty, 0, `${JSON.stringify(validationResults)} moved the score`);
      assert.equal(score, 41);
    }
  });

  it("reads nothing in a column that holds no results", () => {
    for (const value of [null, undefined, "garbage", 42, {}, [{ valid: false }], [{ check: "email_format" }]]) {
      const { score, breakdown } = computeLeadScore(imported({ validationResults: value as unknown }));
      assert.equal(breakdown.penalty, 0, `${JSON.stringify(value)} moved the score`);
      assert.equal(score, 41);
    }
  });

  it("is the same score the same run produced, which is the decay this round ends", () => {
    const results = [{ check: "phone_format", valid: false, message: "Invalid E.164 format" }];
    const row = imported({ validationResults: results });
    const first = computeLeadScore(row);
    const second = computeLeadScore(row);
    assert.equal(first.score, second.score);
    assert.equal(first.score, 31);
    // And the old shape of the bug, kept visible: subtracting from the stored number.
    const code = blankComments(validator);
    assert.ok(!code.includes("lead.score -"), "the worker no longer decrements the column");
    assert.ok(!code.includes("Math.max(0, lead.score"));
  });

  it("keeps the message a check carried, and null when it carried none", () => {
    const { breakdown } = computeLeadScore(imported({ validationResults: [{ check: "a", valid: false, message: "bad" }, { check: "b", valid: false }] }));
    assert.deepEqual(breakdown.failedChecks, [
      { check: "a", message: "bad" },
      { check: "b", message: null },
    ]);
  });

  it("applies to an override too, because a checked defect is a fact about the row", () => {
    const { score } = computeLeadScore(imported({ scoreOverride: 50, validationResults: [{ check: "phone_format", valid: false }] }));
    assert.equal(score, 40);
  });
});

describe("the ledger read back", () => {
  it("survives the Json column it is stored in", () => {
    const { breakdown } = computeLeadScore(completeRow() as ScoreableLead);
    const stored = JSON.parse(JSON.stringify(breakdown));
    assert.deepEqual(readScoreLedger(stored), breakdown);
  });

  it("returns null for anything that is not a ledger", () => {
    for (const value of [null, undefined, "computed", 7, [], [{ column: "email" }], {}, { score: 4 }, { score: 4, computed: 4 }]) {
      assert.equal(readScoreLedger(value), null, `${JSON.stringify(value)} read as a ledger`);
    }
  });

  it("drops a term for a column this table does not read, and keeps the rest", () => {
    const ledger = readScoreLedger({
      basis: "signals",
      computed: 15,
      override: null,
      base: 15,
      earned: [
        { column: "email", points: 15, group: "contact", why: "an address to write to", earned: true },
        { column: "confidence", points: 90, group: "contact", why: "invented", earned: true },
      ],
      missing: ["phone"],
      gaps: ["contact"],
      penalty: 0,
      failedChecks: [],
      score: 15,
    });
    assert.ok(ledger);
    assert.deepEqual(ledger.earned.map((term) => term.column), ["email"]);
    assert.equal(ledger.score, 15);
  });

  it("normalizes a basis it does not know and gaps it cannot name", () => {
    const ledger = readScoreLedger({
      basis: "provider",
      computed: 10,
      base: 10,
      earned: [],
      missing: ["email"],
      gaps: ["contact", "nonsense"],
      penalty: 0,
      failedChecks: ["not a check", { check: "email_format", valid: false }, { message: "no name" }],
      score: 10,
    });
    assert.ok(ledger);
    assert.equal(ledger.basis, "signals");
    assert.equal(ledger.override, null);
    assert.deepEqual(ledger.gaps, ["contact"]);
    assert.deepEqual(ledger.failedChecks, [{ check: "email_format", message: null }]);
  });

  it("is the same object the writers store", () => {
    const write = scoredWriteData(imported());
    assert.equal(write.score, 41);
    assert.ok(write.scoredAt instanceof Date);
    const ledger = readScoreLedger(write.scoreBreakdown);
    assert.ok(ledger);
    assert.equal(ledger.score, 41);
    assert.equal(ledger.computed, 41);
  });

  it("takes a fixed clock, so a writer's stamp is testable", () => {
    const now = new Date("2026-10-21T00:00:00.000Z");
    assert.equal(scoredWriteData(imported(), now).scoredAt, now);
  });
});

describe("rowAfterWrite", () => {
  it("leaves an undefined alone, because Prisma will", () => {
    const row = { email: "a@b.test", company: "Northwind" };
    const merged = rowAfterWrite(row, { company: undefined, title: "VP" });
    assert.equal(merged.company, "Northwind");
    assert.equal(merged.title, "VP");
  });

  it("keeps a null, because that is a clear", () => {
    const merged = rowAfterWrite({ company: "Northwind" }, { company: null });
    assert.equal(merged.company, null);
  });

  it("is what makes a filled column count and an untouched one stay counted", () => {
    const before = computeLeadScore(imported({ seniority: null })).score;
    const after = computeLeadScore(rowAfterWrite(imported({ seniority: null }) as Record<string, unknown>, { seniority: "DIRECTOR" })).score;
    assert.equal(before, 41);
    assert.equal(after, 47);
  });
});

describe("the seven writers, scanned from the source", () => {
  const writers: Array<[string, string]> = [
    ["POST /api/leads", createRoute],
    ["PATCH /api/leads/{id}", patchRoute],
    ["CSV import", csvImport],
    ["scraper", scraper],
    ["VALIDATE worker", validator],
    ["DEDUPE merge", dedupe],
    ["enrichment plan", enrichPlan],
  ];

  for (const [name, src] of writers) {
    it(`${name} writes the score through lead-score`, () => {
      assert.ok(countCodeMentions(src, "scoredWriteData") > 0, `${name} does not call it`);
      assert.ok(src.includes("lead-score"), `${name} does not import it`);
    });
  }

  it("computes the created lead's score in the insert, not after it", () => {
    const body = functionBody(createRoute, "POST_impl") ?? "";
    assert.ok(body.length > 200, "the scan found the handler");
    assert.ok(body.includes("prisma.lead.create"), "one write");
    assert.ok(body.includes("...scoredWriteData(input.data)"));
    assert.ok(!/prisma\.lead\.update/.test(body), "no second write to stamp a number on a row it just made");
  });

  it("routes the PATCH's number into the override, not the column", () => {
    assert.match(patchRoute, /const \{ score, \.\.\.fields \} = input\.data;/);
    assert.match(patchRoute, /scoreOverride = score === undefined \? before\.scoreOverride : score/);
    assert.ok(!/data: input\.data/.test(blankComments(patchRoute)), "the door's data never reaches Prisma whole");
    assert.match(patchRoute, /scoreOverride,/);
    assert.match(patchRoute, /scoredWriteData\(rowAfterWrite\(before, \{ \.\.\.fields, scoreOverride \}\)\)/);
  });

  it("reads the row before it decides its score", () => {
    const body = functionBody(patchRoute, "PATCH_impl") ?? "";
    assert.ok(body.length > 200, "the scan found the handler");
    assert.match(body, /prisma\.lead\.findUnique\(\{ where: \{ id \} \}\)/);
    assert.ok(body.indexOf("findUnique") < body.indexOf("scoredWriteData"), "read, then decide");
  });

  it("scores a CSV row with the row itself", () => {
    assert.match(csvImport, /createManyAndReturn/);
    assert.match(csvImport, /\.\.\.scoredWriteData\(r\.data\)/);
    assert.ok(csvImport.indexOf("...scoredWriteData(r.data)") < csvImport.indexOf("skipDuplicates"), "inside the same insert");
  });

  it("scores both scraper branches", () => {
    assert.equal((scraper.match(/scoredWriteData\(/g) ?? []).length, 2, "the update and the create");
    assert.match(scraper, /scoredWriteData\(rowAfterWrite\(existing, data\)\)/);
    assert.match(scraper, /scoredWriteData\(data\)/);
  });

  it("writes the validator's results and its score in one update", () => {
    assert.equal(countCodeMentions(validator, "prisma.lead.update"), 1, "the decrement write is gone");
    assert.match(validator, /validationResults: results,/);
    assert.match(validator, /scoredWriteData\(rowAfterWrite\(lead, \{ validationResults: results \}\)\)/);
  });

  it("does not write to a row it just deleted", () => {
    const branch = /if \(failedChecks\.length > 0 && config\.action === "remove"\) \{[\s\S]*?\n      \}/.exec(validator)?.[0] ?? "";
    assert.ok(branch.includes("prisma.lead.delete"), "the delete stays");
    assert.ok(branch.includes("continue;"), "and nothing is written to the deleted id afterwards");
    assert.ok(!/prisma\.lead\.delete\(\{ where: \{ id: lead\.id \} \}\);\s*await prisma\.lead\.update/.test(validator));
  });

  it("re-earns the merged survivor's score rather than inheriting one", () => {
    assert.ok(!/const MERGE_SCALARS = \[[\s\S]*?"score"/.test(dedupe), "a merge does not copy the number");
    assert.match(dedupe, /data: \{ \.\.\.updates, \.\.\.scoredWriteData\(rowAfterWrite\(master, updates\)\) \},/);
  });

  it("lets no provider name the score's own columns", () => {
    for (const column of ["score", "scoreOverride", "scoreBreakdown", "scoredAt"]) {
      assert.ok(!(ENRICH_WRITABLE as readonly string[]).includes(column), `${column} is not a provider's`);
    }
    assert.match(enrichPlan, /data: \{ \.\.\.data, \.\.\.scoredWriteData\(rowAfterWrite\(lead, data\)\) \} as Prisma\.LeadUpdateInput/);
  });

  it("is the only arithmetic that prices a lead", () => {
    // One table, everywhere. `dedupe.ts`'s survivor tie-break used to add points to a
    // local named `score`, which is how two signal tables come to disagree in silence.
    const SCORE_MATH = /\bscore\s*[-+]=|[-+]\s+score\b|Math\.(max|min)\([^)]*\bscore\b/;
    const offenders: string[] = [];
    for (const [path, src] of appSources()) {
      if (path.endsWith("lead-score.ts")) continue;
      if (SCORE_MATH.test(blankComments(src))) offenders.push(path);
    }
    assert.deepEqual(offenders, []);
    assert.equal(countCodeMentions(dedupe, "reachable") > 0, true, "the tie-break says what it is");
    assert.ok(appSources().size > 60, `the scan saw ${appSources().size} files`);
  });

  it("reads the ledger rather than re-deriving the arithmetic anywhere else", () => {
    for (const [path, src] of appSources()) {
      if (path.endsWith("lead-score.ts")) continue;
      if (!countCodeMentions(src, "computeLeadScore")) continue;
      assert.ok(
        path.endsWith("explain-lead/route.ts") || path.endsWith("dashboard/page.tsx"),
        `${path} computes a score outside a writer`,
      );
    }
    assert.ok(countCodeMentions(explainRoute, "computeLeadScore") > 0);
    assert.ok(countCodeMentions(dashboard, "readScoreLedger") > 0);
  });
});

describe("the crowd a validation job may re-price", () => {
  it("reads the ids it was given, and nothing it was not", () => {
    assert.equal(namedLeads(undefined), null, "no list means the whole workspace");
    assert.equal(namedLeads([]), null, "an empty list is not a crowd");
    assert.equal(namedLeads("lead_1"), null, "a string is not a list");
    assert.equal(namedLeads({ id: "lead_1" }), null, "an object is not a list");
    assert.deepEqual(namedLeads([42, null, "", "  ", {}, "lead_1"]), ["lead_1"]);
    assert.deepEqual(namedLeads(["lead_1", "lead_1", "lead_2"]), ["lead_1", "lead_2"], "named twice, checked once");
  });

  it("keeps the workspace filter whichever way the crowd goes", () => {
    const code = blankComments(validator);
    // The scoping is one statement now: `crowdWhere` keeps the workspace
    // filter and adds the crowd, so a named crowd can never widen the query.
    assert.match(code, /where: crowdWhere\(\{ workspaceId: job\.workspaceId \}, namedLeads\(config\.leadIds\)\)/);
    assert.equal((code.match(/workspaceId: job\.workspaceId/g) ?? []).length, 1, "one where, and it is scoped");
    // The scope lives in the base the caller passes, so the narrowing cannot replace it.
    assert.deepEqual(crowdWhere({ workspaceId: "ws_1" }, ["lead_1"]), { workspaceId: "ws_1", id: { in: ["lead_1"] } });
    assert.deepEqual(crowdWhere({ workspaceId: "ws_1" }, null), { workspaceId: "ws_1" });
  });

  it("is the module's own arithmetic at that write too", () => {
    assert.match(blankComments(validator), /scoredWriteData\(rowAfterWrite\(lead, \{ validationResults: results \}\)\)/);
  });
});

describe("the buyer's read path", () => {
  it("answers with the arithmetic whether or not a model is configured", () => {
    assert.equal((explainRoute.match(/\.\.\.arithmetic/g) ?? []).length, 3, "all three responses carry it");
    assert.match(explainRoute, /breakdown: ledger,/);
    assert.match(explainRoute, /stale: lead\.score !== live\.score/);
    assert.ok(!explainRoute.includes("the deterministic score is unaffected"), "the sentence about a score that did not exist");
  });

  it("says what the number means where the list is sorted by it", () => {
    assert.match(dashboard, /orderBy: \{ score: "desc" \}/);
    assert.match(dashboard, /function scoreLedger/);
    assert.match(dashboard, /readScoreLedger\(lead\.scoreBreakdown\) \?\? computeLeadScore\(lead\)\.breakdown/);
    assert.match(dashboard, /typed \$\{ledger\.override\} · the row earns \$\{ledger\.computed\}/);
    assert.match(dashboard, /not how important the person is/);
    assert.ok(!dashboard.includes("computes the score from enrichment signals"), "the claim it used to make");
  });
});
