// #33 — the enrichment log's other half: what the row said when the provider answered.
//
// Measured against the running app before this round. Three leads, the same
// "Chief Operating Officer", one rule each, `derive` as the only provider:
//
//   * a rep had typed `VP` into the row — the provider offered `C_LEVEL`, the plan
//     refused it, the row stayed `VP`;
//   * the rule declared `fields: ["industry"]`, so the `seniority` the provider
//     answered was pruned before the plan ever saw it;
//   * the gap case — the row held nothing and `C_LEVEL` landed.
//
// The first two left **byte-identical** log rows:
// `["PARTIAL", [], null, {}, "derive"]`. `EnrichmentLog.beforeData`, the column the
// schema pairs with `afterData` for exactly this audit, was `null` in all three, and
// the third case — the one where something *was* written — carried `beforeData: null`
// too, so the row held nothing, a provider answered, and the record did not say which.
// Two opposite facts ("the row's own word won" vs "nobody asked for that") were stored
// as one silence.
//
// What this file pins, in the order the code runs:
//
//   1. the schema's own pair — `beforeData` beside `afterData`, both on
//      `EnrichmentLog`, and the vocabulary the record is allowed to use;
//   2. `planEnrichmentWrite`'s `before`: keyed by what was *answered*, never by what
//      was written, `null` where the row held nothing, the row's own value where it
//      refused, and JSON-safe the way a `Json` column needs;
//   3. the two halves read together — a filled gap, a refused collision, a dropped
//      shape mismatch, a pruned-away answer, and a second visit that changes nothing;
//   4. the wiring, scanned from the source — the worker stores `before` in
//      `beforeData`, the failure path invents nothing, the detail door hands both
//      halves to the caller, and the AI explanation keeps reading the row as it is.
//
// The live proof is `demo/run-demo.sh leadworks` STEP 14; every failure mode here is
// reachable without a database, so none of these tests asks for one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import { ENRICH_WRITABLE, planEnrichmentWrite, type EnrichableLead } from "../../src/lib/enrich-plan";
import { restrictToDeclared } from "../../src/lib/rule-actions";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const enrichment = at("../../src/lib/enrichment.ts");
const detailRoute = at("../../src/app/api/leads/[id]/route.ts");
const explainRoute = at("../../src/app/api/ai/explain-lead/route.ts");

/** A lead as the worker sees it: an imported row with a title and nothing else filled. */
function importedLead(over: Record<string, unknown> = {}): EnrichableLead {
  return {
    status: "NEW",
    email: "dana@provenance.test",
    company: "Provenance Estates",
    title: "Chief Operating Officer",
    firstName: null,
    lastName: null,
    phone: null,
    linkedinUrl: null,
    department: null,
    seniority: null,
    location: "Amman",
    country: "Jordan",
    industry: null,
    companySize: null,
    revenue: null,
    technologies: [],
    intentSignals: [],
    socialProfiles: {},
    customFields: {},
    score: 47,
    scoreOverride: null,
    scoreBreakdown: null,
    ...over,
  };
}

/** The log's pair, as the schema declares it. */
const LOG_BLOCK = schema.slice(schema.indexOf("model EnrichmentLog"), schema.indexOf("model EnrichmentLog") + 900);

describe("the schema already asked for both halves", () => {
  it("pairs what the row said with what it became", () => {
    assert.match(LOG_BLOCK, /beforeData\s+Json\?/);
    assert.match(LOG_BLOCK, /afterData\s+Json\?/);
    const before = LOG_BLOCK.indexOf("beforeData");
    const after = LOG_BLOCK.indexOf("afterData");
    const fields = LOG_BLOCK.indexOf("fieldsEnriched");
    assert.ok(before > fields && after > before, "the audit triple, in the order a reader wants it");
  });

  it("reports only columns an enrichment may touch", () => {
    const plan = planEnrichmentWrite(importedLead(), {
      seniority: "C_LEVEL",
      workspaceId: "other-tenant",
      status: "CONVERTED",
      tags: ["vip"],
      score: 5,
      confidence: 0.9,
    });
    for (const column of Object.keys(plan.before)) {
      assert.ok((ENRICH_WRITABLE as readonly string[]).includes(column), `${column} is not an enrichment column`);
    }
  });
});

describe("planEnrichmentWrite.before: what the row said, for every answer", () => {
  it("keys the record by what was answered, not by what landed", () => {
    const plan = planEnrichmentWrite(importedLead({ seniority: "VP" }), { seniority: "C_LEVEL" });
    assert.deepEqual(plan.written, [], "the typed word outlives the guess");
    assert.deepEqual(plan.before, { seniority: "VP" }, "and the refusal is the fact worth keeping");
  });

  it("writes the row's nothing as a null, so a gap is distinguishable from a refusal", () => {
    const plan = planEnrichmentWrite(importedLead(), { seniority: "C_LEVEL" });
    assert.deepEqual(plan.before, { seniority: null });
    assert.deepEqual(plan.written, ["seniority"]);
    assert.equal(plan.logStatus, "SUCCESS");
  });

  it("records a blank and an empty list as the gap they are, with the row's own value", () => {
    const plan = planEnrichmentWrite(importedLead({ seniority: "  ", technologies: [] }), { seniority: "IC", technologies: ["React"] });
    assert.deepEqual(plan.before, { seniority: "  ", technologies: [] }, "the blank is what the row said");
    assert.deepEqual(plan.written.sort(), ["seniority", "technologies"]);
  });

  it("keeps a dropped shape mismatch visible instead of silent", () => {
    // A provider handing back a bare string for a column that holds a list of words:
    // the plan refuses to coerce it. Before this round that refusal left no trace.
    const plan = planEnrichmentWrite(importedLead({ technologies: ["React"] }), { technologies: "React" });
    assert.deepEqual(plan.written, []);
    assert.deepEqual(plan.before, { technologies: ["React"] });
    assert.equal(plan.logStatus, "PARTIAL");
  });

  it("says nothing about a column the provider did not answer", () => {
    const plan = planEnrichmentWrite(importedLead(), { seniority: "C_LEVEL" });
    assert.deepEqual(Object.keys(plan.before), ["seniority"]);
    assert.ok(!("email" in plan.before), "the row's email was never in question");
    assert.ok(!("industry" in plan.before), "and no answer arrived for it");
  });

  it("is the empty record when the rule's own declaration pruned the answer away", () => {
    // The second of the two cases that used to be identical to the first: `derive`
    // answered `seniority`, the rule asked for `industry`, so nothing reached the plan.
    const answered = { seniority: "C_LEVEL" };
    const plan = planEnrichmentWrite(importedLead(), restrictToDeclared(answered, ["industry"]));
    assert.deepEqual(plan.before, {});
    assert.deepEqual(plan.written, []);
    assert.equal(plan.logStatus, "PARTIAL");
  });

  it("tells a refusal apart from a pruned-away answer", () => {
    const refused = planEnrichmentWrite(importedLead({ seniority: "VP" }), { seniority: "C_LEVEL" });
    const pruned = planEnrichmentWrite(importedLead({ seniority: "VP" }), restrictToDeclared({ seniority: "C_LEVEL" }, ["industry"]));
    assert.equal(JSON.stringify([refused.logStatus, refused.written, refused.before]), '["PARTIAL",[],{"seniority":"VP"}]');
    assert.equal(JSON.stringify([pruned.logStatus, pruned.written, pruned.before]), '["PARTIAL",[],{}]');
  });

  it("carries no value a Json column cannot store", () => {
    const plan = planEnrichmentWrite(importedLead({ industry: undefined }), { seniority: "C_LEVEL", companySize: "51-200" });
    const asJson = JSON.parse(JSON.stringify(plan.before));
    assert.deepEqual(asJson, plan.before, "the record round-trips through the column it is stored in");
    for (const value of Object.values(plan.before)) assert.notEqual(value, undefined, "an undefined value would vanish from the row");
  });

  it("reports the second visit's refusal against what the first one wrote", () => {
    const first = planEnrichmentWrite(importedLead(), { seniority: "C_LEVEL" });
    const writtenLead = importedLead({ seniority: first.data.seniority, status: "ENRICHED" });
    const second = planEnrichmentWrite(writtenLead, { seniority: "C_LEVEL" });
    assert.deepEqual(second.written, [], "enrichment is additive: the gap closed on the first run");
    assert.deepEqual(second.before, { seniority: "C_LEVEL" }, "and the record says the value was already there");
  });

  it("lists every answered column even when only some of them land", () => {
    const plan = planEnrichmentWrite(importedLead({ industry: "Training" }), { seniority: "C_LEVEL", industry: "Real Estate", companySize: "51-200" });
    assert.deepEqual(plan.written.sort(), ["companySize", "seniority"]);
    assert.deepEqual(
      Object.keys(plan.before).sort(),
      ["companySize", "industry", "seniority"],
      "the answer set, not the write set — that is the audit",
    );
    assert.equal(plan.before.industry, "Training", "including the one that was refused");
  });
});

describe("the wiring, from the source", () => {
  it("stores the row's own words in the column the schema made for them", () => {
    const body = functionBody(enrichment, "updateLeadEnrichment")!;
    assert.match(body, /beforeData: asInputJson\(plan\.before\)/);
    assert.match(body, /afterData: Object\.fromEntries\(plan\.written/);
    assert.match(body, /fieldsEnriched: plan\.written/);
    const order = [body.indexOf("fieldsEnriched"), body.indexOf("beforeData"), body.indexOf("afterData")];
    assert.deepEqual([...order].sort((a, b) => a - b), order, "one log row carries the triple, in the schema's order");
  });

  it("asks the plan once, so the log and the write are the same visit", () => {
    const body = blankComments(functionBody(enrichment, "updateLeadEnrichment")!);
    assert.equal(body.split("planEnrichmentWrite(").length - 1, 1, "one plan per visit");
    assert.match(body, /prisma\.lead\.update\(\{ where: \{ id: lead\.id \}, data: plan\.data \}\)/);
  });

  it("invents no before-values on a visit that threw", () => {
    const body = blankComments(functionBody(enrichment, "logEnrichmentError")!);
    assert.ok(!body.includes("beforeData"), "nothing was answered, so there is nothing the row could be said to have been asked");
    assert.ok(!body.includes("afterData"), "and nothing landed either");
    assert.match(body, /status: "FAILED"/);
  });

  it("hands both halves to whoever asks for the lead", () => {
    const code = blankComments(detailRoute);
    const include = code.slice(code.indexOf("enrichmentLogs:"), code.indexOf("enrichmentLogs:") + 120);
    assert.ok(!include.includes("select"), `${include.trim()} — a whole row, not a chosen few`);
    assert.match(code, /enrichmentLogs: \{ orderBy: \{ createdAt: "desc" \}/);
  });

  it("keeps the AI explanation reading the row, not the record of what lost", () => {
    const code = blankComments(explainRoute);
    assert.match(code, /Object\.assign\(enrichment, log\.afterData/, "what landed is a signal the score is made of");
    assert.ok(!code.includes("log.beforeData"), "what the row said before is provenance, not a fresh input to explain");
  });

  it("leaves the plan's other two answers untouched", () => {
    // The round adds a field; it must not move a byte of what #29 pinned.
    const filled = planEnrichmentWrite(importedLead(), { seniority: "DIRECTOR" });
    assert.equal(filled.data.score, 43, "email 15 + company 10 + title 6 + seniority 6 + location 3 + country 3");
    assert.equal(filled.data.status, "ENRICHED");
    const refused = planEnrichmentWrite(importedLead({ seniority: "MANAGER" }), { seniority: "DIRECTOR" });
    assert.equal(refused.data.status, undefined);
    assert.equal(refused.data.seniority, undefined);
    assert.ok(refused.data.lastEnrichedAt instanceof Date, "the visit is still a visit");
  });
});
