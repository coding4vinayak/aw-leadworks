// #29 — the enrichment write, which threw, and the one signal that now lands, pinned offline.
//
// Measured against the running app before this round: `runEnrichmentJob` called
// `enrichLead`, which returned `{ ...results, confidence: 0.7 }`, and
// `updateLeadEnrichment` spread that straight into `prisma.lead.update`. `Lead` has
// no `confidence` column, so Prisma refused the whole update, every lead a rule named
// came back in `Job.failedItems`, and the row kept `lastEnrichedAt: null`. Enrichment
// — the feature on the front of the sales page — wrote nothing for anybody, and
// reported itself as failing while doing it. Behind that sat a second hazard: the same
// spread computed `score` from the provider's return value, so had the update landed it
// would have written `score: 5` over a lead whose real signals earned 82. And
// `EnrichmentLog.workspaceId` was the literal `""`, which the FK would have refused too.
//
// What this file pins, in the order the code runs:
//
//   1. the schema's own words — the rungs `Lead.seniority` comments, and that every
//      column the write plan may touch is a column `Lead` actually has;
//   2. the title table, answer for answer, including the three titles whose words would
//      answer the wrong rung and the ambiguous ones it refuses to judge;
//   3. the provider vocabulary: that the names a rule may list are exactly the names the
//      worker's `switch` dispatches on, checked in both directions from the source;
//   4. the write plan: gap-only, never a non-column, never `score`, shape mismatches
//      dropped rather than coerced, one status advance, idempotent, and honest about a
//      visit that learned nothing;
//   5. the wiring itself, scanned from the source — the worker's call, the log row's real
//      workspace, the two rule doors refusing an unusable provider before the row exists.
//
// The live proof that a rule now enriches is the demo's job (STEP 10); none of the ways
// this used to be wrong needs a database to be wrong about, so none is asked for one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import { LEAD_SENIORITIES, LEAD_STATUSES } from "../../src/lib/enums";
import { seniorityFromTitle, seniorityTableRungs } from "../../src/lib/seniority";
import { ENRICHMENT_PROVIDERS, normalizeProviders, providersProblem } from "../../src/lib/enrichment-providers";
import { ENRICH_WRITABLE, planEnrichmentWrite, type EnrichableLead } from "../../src/lib/enrich-plan";
import { readScoreLedger } from "../../src/lib/lead-score";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const enrichment = at("../../src/lib/enrichment.ts");
const scheduler = at("../../src/lib/scheduler.ts");
const ruleRoute = at("../../src/app/api/enrichment-rules/route.ts");
const ruleIdRoute = at("../../src/app/api/enrichment-rules/[id]/route.ts");

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
    if (!m) continue;
    const [, name, type] = m;
    if (["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json"].includes(type)) out.add(name);
  }
  return out;
}

/** The words a `Lead` column's schema comment spells out, e.g. `IC | MANAGER | …`. */
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

/** The text around an anchor, for a claim about what sits inside one object literal. */
const around = (haystack: string, anchor: string, span: number): string => {
  const i = first(haystack, anchor);
  return haystack.slice(i, i + span);
};

/** A row with the gaps an imported lead has: a title, and nothing under it. */
function importedLead(over: Record<string, unknown> = {}): EnrichableLead {
  return {
    id: "lead_1",
    status: "NEW",
    email: "meera@northwind.test",
    company: "Northwind",
    title: "Director of Demand Generation",
    seniority: null,
    score: 82,
    tags: ["aim-x"],
    ...over,
  };
}

describe("the columns this may touch, in the schema's words", () => {
  it("has a seniority column whose comment is the rung list", () => {
    assert.deepEqual(commentSet("seniority"), [...LEAD_SENIORITIES]);
  });

  it("names only real Lead columns as writable", () => {
    const columns = leadColumns();
    for (const column of ENRICH_WRITABLE) {
      assert.ok(columns.has(column), `${column} is not a column on Lead`);
    }
  });

  it("keeps the row's identity and its other owners out of the writable set", () => {
    for (const column of ["id", "workspaceId", "sourceId", "sourceRef", "score", "status", "tags", "validationResults", "lastContactedAt", "createdAt", "updatedAt"]) {
      assert.ok(!ENRICH_WRITABLE.includes(column as (typeof ENRICH_WRITABLE)[number]), `${column} must never be written by an enrichment visit`);
    }
  });

  it("does not write confidence, the value that threw", () => {
    assert.ok(!ENRICH_WRITABLE.includes("confidence" as (typeof ENRICH_WRITABLE)[number]));
    assert.ok(!leadColumns().has("confidence"), "if Lead grew a confidence column this claim needs re-reading");
  });

  it("can only name a rung the column holds", () => {
    for (const rung of seniorityTableRungs()) {
      assert.ok((LEAD_SENIORITIES as readonly string[]).includes(rung), `${rung} is not a seniority the schema spells`);
    }
  });

  it("never invents UNKNOWN, which is a judgment and not a lookup", () => {
    assert.ok(!seniorityTableRungs().includes("UNKNOWN"));
    for (const title of ["", "  ", "Widget Whisperer", "EVP", null, undefined, 42]) {
      assert.equal(seniorityFromTitle(title as string | null | undefined), null, JSON.stringify(title));
    }
  });
});

describe("seniorityFromTitle: the table, answer for answer", () => {
  it("answers each rung from the titles that state it", () => {
    const known: [string, string][] = [
      ["Chief Executive Officer", "C_LEVEL"],
      ["CEO", "C_LEVEL"],
      ["cto", "C_LEVEL"],
      ["Chief Operating Officer", "C_LEVEL"],
      ["Founder & Co-founder", "C_LEVEL"],
      ["Managing Director", "C_LEVEL"],
      ["Managing director", "C_LEVEL"],
      ["Owner", "C_LEVEL"],
      ["Vice President of Sales", "VP"],
      ["VP Marketing", "VP"],
      ["vp", "VP"],
      ["Director of Demand Generation", "DIRECTOR"],
      ["Head of Engineering", "DIRECTOR"],
      ["head of sales", "DIRECTOR"],
      ["General Manager", "DIRECTOR"],
      ["Product Manager", "MANAGER"],
      ["Support Supervisor", "MANAGER"],
      ["Senior Engineer", "IC"],
      ["Marketing Coordinator", "IC"],
      ["Solutions Consultant", "IC"],
      ["Customer Success Specialist", "IC"],
      ["Software Developer", "IC"],
    ];
    for (const [title, rung] of known) {
      assert.equal(seniorityFromTitle(title), rung, title);
    }
  });

  it("reads the phrase where a word scan would answer a different rung", () => {
    // President, Director and Manager are each in the table at another rung, and each
    // of these titles means something else than the word it contains.
    assert.equal(seniorityFromTitle("Vice President"), "VP");
    assert.equal(seniorityFromTitle("Managing Director"), "C_LEVEL");
    assert.equal(seniorityFromTitle("General Manager"), "DIRECTOR");
  });

  it("abstains where the title straddles two rungs", () => {
    for (const title of ["Head of Growth", "Team Lead", "Principal", "Architect", "EVP", "Chief of Staff", "Lead"] as const) {
      assert.equal(seniorityFromTitle(title), null, title);
    }
  });

  it("folds case, padding and repeated spaces without folding meaning", () => {
    assert.equal(seniorityFromTitle("  VP   of Sales "), "VP");
    assert.equal(seniorityFromTitle("VICE PRESIDENT"), "VP");
    assert.equal(seniorityFromTitle("Director of Demand Generation"), "DIRECTOR");
  });

  it("does not find a rung inside a longer word", () => {
    assert.equal(seniorityFromTitle("Sales Managers"), null);
    assert.equal(seniorityFromTitle("VPX Industries analyst"), "IC");
    assert.equal(seniorityFromTitle("Bureau Chief"), null);
  });

  it("abstains on a title that is not a string or is blank", () => {
    assert.equal(seniorityFromTitle(null), null);
    assert.equal(seniorityFromTitle(undefined), null);
    assert.equal(seniorityFromTitle(""), null);
    assert.equal(seniorityFromTitle("   "), null);
  });
});

describe("the provider names a rule may list", () => {
  it("accepts every name the worker dispatches on", () => {
    for (const name of ENRICHMENT_PROVIDERS) {
      assert.equal(providersProblem([name]), null, name);
      assert.deepEqual(normalizeProviders([name]), [name], name);
    }
  });

  it("refuses a name nothing implements, quoting the list it could use", () => {
    const problem = providersProblem(["hubspot"]);
    assert.ok(problem !== null);
    assert.match(problem, /"hubspot"/);
    assert.match(problem, /not a provider this product calls/);
    for (const name of ENRICHMENT_PROVIDERS) assert.ok(problem.includes(name), problem);
  });

  it("names every offender in one answer", () => {
    const problem = providersProblem(["hubspot", "semrush", "apollo"])!;
    assert.match(problem, /"hubspot", "semrush"/);
    assert.ok(!problem.includes('"apollo" is'), "apollo is a real name and must not be in the complaint");
    assert.match(problem, /\bare\b/, "two offenders read as a list, not as one thing");
  });

  it("refuses a list that is not a list", () => {
    for (const bad of ["apollo", 42, null, { provider: "apollo" }]) {
      assert.ok(providersProblem(bad) !== null, JSON.stringify(bad));
    }
  });

  it("takes an empty list as nothing to complain about, which the shape check owns", () => {
    // `RULE_CREATE` requires `min: 1`; `providersProblem` is about meaning only.
    assert.equal(providersProblem([]), null);
  });

  it("folds the spelling a sales page uses onto the spelling the switch compares", () => {
    assert.equal(providersProblem(["Apollo", " CLEARBIT "]), null);
    assert.deepEqual(normalizeProviders(["Apollo", " CLEARBIT ", "apollo"]), ["apollo", "clearbit"]);
  });

  it("drops what no case can answer rather than storing a silent name", () => {
    assert.deepEqual(normalizeProviders(["derive", "hubspot"]), ["derive"]);
    assert.deepEqual(normalizeProviders("derive"), []);
  });

  it("is kept out of enums.ts, which takes only the sets a write route accepts", () => {
    const enums = at("../../src/lib/enums.ts");
    for (const name of ENRICHMENT_PROVIDERS) {
      assert.ok(!enums.includes(`"${name}"`), `${name} does not belong in enums.ts`);
    }
  });

  it("matches the worker's dispatch table in both directions", () => {
    // The dispatch table is PROVIDER_IMPLEMENTATIONS in enrichment-providers-impl.ts
    const implBody = readFileSync(new URL("../../src/lib/enrichment-providers-impl.ts", import.meta.url), "utf8");
    // Match the object literal after the = sign (handles multi-line type annotation)
    const implMatch = implBody.match(/PROVIDER_IMPLEMENTATIONS\s*:\s*Record<string,[\s\S]*?\)\s*=>\s*Promise<Partial<EnrichmentResult>\s*\|\s*null>>\s*=\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(implMatch, "PROVIDER_IMPLEMENTATIONS object not found in enrichment-providers-impl.ts");
    const implKeys = [...implMatch[1].matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual([...ENRICHMENT_PROVIDERS].sort(), [...new Set(implKeys)].sort(), "the list and the implementation keys cannot drift apart");
  });

  it("has exactly one provider that answers without a key", () => {
    // Only `derive` works without an API key; the rest require credentials and return null
    // when unconfigured. The test ensures no provider invents data.
    const body = blankComments(enrichment);
    assert.ok(!/industry:\s*"SaaS"/.test(body), "the fabricated company answers must stay deleted");
    assert.ok(!/companySize:\s*"/.test(body), "fabricated company size must stay deleted");
    assert.ok(!/return \{ confidence:/.test(body), "a confidence no provider earned");
  });
});

describe("planEnrichmentWrite: what a visit may put in the row", () => {
  it("fills the gap a title states, and says so", () => {
    const plan = planEnrichmentWrite(importedLead(), { seniority: "DIRECTOR" });
    assert.deepEqual(plan.written, ["seniority"]);
    assert.equal(plan.data.seniority, "DIRECTOR");
    assert.equal(plan.logStatus, "SUCCESS");
    // The schema's own word for "we enriched this", and this is the only code that
    // moves a row into it.
    assert.equal(plan.data.status, "ENRICHED");
    assert.ok(plan.data.lastEnrichedAt instanceof Date);
  });

  it("leaves a value a person set alone", () => {
    const plan = planEnrichmentWrite(importedLead({ seniority: "MANAGER" }), { seniority: "VP", title: "Someone Else" });
    assert.deepEqual(plan.written, []);
    assert.equal(plan.data.seniority, undefined);
    assert.equal(plan.data.title, undefined, "the row already has a title");
    assert.equal(plan.logStatus, "PARTIAL");
    assert.equal(plan.data.status, undefined, "nothing landed, so no status is earned");
  });

  it("treats a blank string and an empty list as gaps, not as values", () => {
    const plan = planEnrichmentWrite(importedLead({ seniority: "  ", technologies: [] }), { seniority: "IC", technologies: ["React"] });
    assert.deepEqual(plan.written.sort(), ["seniority", "technologies"]);
    assert.deepEqual(plan.data.technologies, ["React"]);
  });

  it("carries no value that is not a column, and none of the score's columns by name", () => {
    const plan = planEnrichmentWrite(importedLead(), {
      seniority: "DIRECTOR",
      confidence: 0.9,
      score: 5,
      scoreOverride: 5,
      someWeirdKey: "x",
      enrichmentId: "evt_1",
    });
    // `lead-score.ts` owns three columns and writes them through its own helper; a
    // provider may not name them, and nothing else may appear in the update.
    const SCORE_OWNED = ["score", "scoreBreakdown", "scoredAt"];
    const keys = Object.keys(plan.data);
    for (const key of keys) {
      assert.ok(
        key === "lastEnrichedAt" || (ENRICH_WRITABLE as readonly string[]).includes(key) || key === "status" || SCORE_OWNED.includes(key),
        `wrote ${key}`,
      );
    }
    assert.ok(!keys.includes("confidence"));
    assert.ok(!keys.includes("someWeirdKey"));
    assert.notEqual(plan.data.score, 5, "a provider's number is not the score");
  });

  it("receives no score, and writes the one the row earns", () => {
    // #30 moved this column from "not the enrichment's to invent" to "not the
    // enrichment's to receive": a visit fills signal columns, and a score that did
    // not follow them would put the buyer's sort order behind the data.
    const earned = planEnrichmentWrite(importedLead({ seniority: null, scoreOverride: null }), { seniority: "DIRECTOR", score: 5 });
    assert.equal(earned.written.length, 1);
    assert.equal(earned.data.score, 37, "email 15 + company 10 + title 6 + seniority 6");
    assert.equal(readScoreLedger(earned.data.scoreBreakdown)!.basis, "signals");

    const typed = planEnrichmentWrite(importedLead({ seniority: null, score: 0, scoreOverride: 82 }), { seniority: "DIRECTOR" });
    assert.equal(typed.data.score, 82, "a person's number outranks the arithmetic");
    const ledger = readScoreLedger(typed.data.scoreBreakdown)!;
    assert.equal(ledger.basis, "override");
    assert.equal(ledger.computed, 37, "and the row still shows what it earns beside it");
  });

  it("drops a value whose shape the column cannot hold, rather than coercing it", () => {
    const plan = planEnrichmentWrite(importedLead({ technologies: null, socialProfiles: null }), {
      technologies: "React",
      seniority: ["DIRECTOR"],
      socialProfiles: "linkedin",
    });
    assert.deepEqual(plan.written, []);
    assert.equal(plan.logStatus, "PARTIAL");
  });

  it("keeps the list columns lists and the map columns maps", () => {
    const plan = planEnrichmentWrite(importedLead({ technologies: null, intentSignals: null, socialProfiles: null, customFields: null }), {
      technologies: ["React", "Node.js"],
      intentSignals: ["pricing page"],
      socialProfiles: { linkedin: "https://linkedin.com/in/meera" },
      customFields: { region: "EMEA" },
    });
    assert.deepEqual(plan.written.sort(), ["customFields", "intentSignals", "socialProfiles", "technologies"]);
  });

  it("refuses a list with a non-word or an empty word in it", () => {
    const plan = planEnrichmentWrite(importedLead({ technologies: null }), { technologies: ["React", 42], intentSignals: [""] });
    assert.deepEqual(plan.written, []);
  });

  it("advances the status from nothing else, and never from a later stage", () => {
    for (const status of LEAD_STATUSES) {
      const plan = planEnrichmentWrite(importedLead({ status }), { seniority: "DIRECTOR" });
      if (status === "NEW") {
        assert.equal(plan.data.status, "ENRICHED");
      } else {
        assert.equal(plan.data.status, undefined, `${status} is not an enrichment's to overwrite`);
      }
    }
  });

  it("stamps the visit and logs PARTIAL when the visit learned nothing", () => {
    for (const answer of [null, undefined, {}, { confidence: 0.7 }, { seniority: null }]) {
      const plan = planEnrichmentWrite(importedLead(), answer as Record<string, unknown> | null);
      assert.ok(plan.data.lastEnrichedAt instanceof Date, "the worker did look at this row");
      assert.deepEqual(plan.written, []);
      assert.equal(plan.logStatus, "PARTIAL");
      assert.equal(plan.data.status, undefined);
    }
  });

  it("is idempotent: a second visit writes nothing the first one did", () => {
    const lead = importedLead();
    const visit = planEnrichmentWrite(lead, { seniority: "DIRECTOR" });
    assert.deepEqual(visit.written, ["seniority"]);
    // The row as it reads after that update: the gap is filled and the status moved.
    const after: EnrichableLead = { ...lead, seniority: "DIRECTOR", status: "ENRICHED" };
    const again = planEnrichmentWrite(after, { seniority: "DIRECTOR" });
    assert.deepEqual(again.written, []);
    assert.equal(again.logStatus, "PARTIAL");
    assert.equal(again.data.status, undefined, "the row is already ENRICHED");
  });
});

describe("the worker and the doors are wired", () => {
  it("writes through the plan, and passes the job's workspace to the log", () => {
    const body = blankComments(functionBody(enrichment, "updateLeadEnrichment")!);
    assert.match(body, /const plan = planEnrichmentWrite\(lead, result\)/);
    assert.match(body, /data: plan\.data/);
    assert.ok(!/\.\.\.result/.test(body), "the provider's answer is never spread into the row");
    // The hardcoded `workspaceId: ""` was an FK violation waiting to happen.
    assert.match(body, /^\s*workspaceId,/m);
    assert.ok(!/workspaceId: ""/.test(body));
    assert.match(body, /fieldsEnriched: plan\.written/);
    assert.match(body, /status: plan\.logStatus/);
  });

  it("takes the row it read, so a gap is judged against the row", () => {
    const body = blankComments(functionBody(enrichment, "runEnrichmentJob")!);
    assert.match(body, /updateLeadEnrichment\(job\.workspaceId, lead, answer\.columns, config\.providers, ruleId\)/);
  });

  it("logs the visit against the rule that queued it, once that rule is checked", () => {
    // `EnrichmentLog.ruleId` is how a rule's own page shows what it did; the id comes
    // from the job's config, which any caller of POST /api/jobs can write, so it is
    // resolved against the job's workspace instead of trusted.
    const body = blankComments(functionBody(enrichment, "runEnrichmentJob")!);
    assert.match(body, /const ruleId = await usableRuleId\(job\.workspaceId, config\.ruleId\)/);
    const guard = blankComments(functionBody(enrichment, "usableRuleId")!);
    assert.match(guard, /where: \{ id: claimed, workspaceId \}/);
    assert.match(guard, /return owned\?\.id \?\? null/);
    const log = blankComments(functionBody(enrichment, "updateLeadEnrichment")!);
    assert.match(log, /^\s*ruleId,/m);
    for (const [where, text] of [["scheduler.ts", scheduler], ["?action=run", ruleIdRoute]] as const) {
      assert.match(around(text, 'type: "ENRICH"', 400), /ruleId: rule\.id/, `${where} must carry the rule into the job`);
    }
  });

  it("has no scorer left in the enrichment path", () => {
    assert.ok(!enrichment.includes("calculateLeadScore"), "the score is the workspace's, not a byproduct of a call");
    assert.ok(!enrichment.includes("score:"), "nothing in the worker writes a score");
  });

  it("normalises the stored provider list before dispatching", () => {
    const body = blankComments(functionBody(enrichment, "runEnrichmentJob")!);
    assert.match(body, /config\.providers = normalizeProviders\(config\.providers\)/);
    assert.ok(first(body, "normalizeProviders") < first(body, "getLeadsToEnrich"), "before the leads are chosen");
  });

  it("derives from the row's own title", () => {
    // The derive provider is now in PROVIDER_IMPLEMENTATIONS
    const implBody = readFileSync(new URL("../../src/lib/enrichment-providers-impl.ts", import.meta.url), "utf8");
    assert.match(implBody, /seniorityFromTitle\(lead\.title\)/, "derive provider reads lead.title");
    const dispatch = blankComments(functionBody(enrichment, "enrichWithProvider")!);
    assert.match(dispatch, /PROVIDER_IMPLEMENTATIONS\[provider\]/, "dispatch uses implementation map");
  });

  it("refuses an unusable provider at create, before the row exists", () => {
    const body = blankComments(functionBody(ruleRoute, "POST_impl")!);
    assert.ok(first(body, "validateBody") < first(body, "providersProblem"), "shape first, meaning second");
    assert.ok(first(body, "conditionsProblem") < first(body, "providersProblem"), "both meanings, before either write");
    assert.ok(first(body, "providersProblem") < first(body, "prisma.enrichmentRule.create"));
    assert.match(body, /providersProblem\(input\.data\.providers\)/);
    assert.match(body, /providers: asInputJson\(normalizeProviders\(input\.data\.providers\)\)/);
  });

  it("refuses a redeclared provider on patch, and leaves a patch that says nothing alone", () => {
    const body = blankComments(functionBody(ruleIdRoute, "PATCH_impl")!);
    assert.match(body, /const named = input\.data\.providers;\s*if \(named !== undefined\)/);
    assert.ok(first(body, "providersProblem") < first(body, "prisma.enrichmentRule.update"));
    assert.match(body, /named === undefined \? \{\} : \{ providers: asInputJson\(normalizeProviders\(named\)\) \}/);
  });

  it("asks the rules API to require providers, so a rule always names something", () => {
    const fields = at("../../src/lib/fields.ts");
    assert.match(fields, /providers: \{ kind: "strings", required: true, min: 1 \}/);
  });
});
