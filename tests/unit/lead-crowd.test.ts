// #31 — the leads a background job is told to work on, pinned offline.
//
// Two doors mean specific people: `POST /api/leads/{id}?action=enrich`, which puts an
// id in the URL, and `VALIDATE` with `leadIds`. Neither used to carry it to the
// worker. Measured against the running app before the fix, on a workspace holding 20
// leads: one click on one lead's row queued a job with no crowd, the worker selected
// `where: { workspaceId }` with `take: 1000`, and the job came back `processed=20` —
// the whole list walked by a request that named one person, with the three providers
// that answer nothing without a key, so no column was filled and not even
// `lastEnrichedAt` was stamped. The scheduler had the same split the other way: it
// counted 100 leads into `totalItems` and then handed the worker the rule's
// conditions to re-derive a crowd of its own, up to ten times as many.
//
// What this file pins, in the order the code runs:
//
//   1. `namedLeads` — every shape a caller can put in a JSON column, and which of
//      them mean "not named";
//   2. `crowdWhere` — that naming narrows a scope and cannot replace or widen one;
//   3. the wiring, scanned from the source — both workers read the shared module, the
//      lead door names the id it was handed, the scheduler and the bulk queue carry the
//      ids they counted, and the rule's own run door still means its whole crowd;
//   4. that the only module on the job path which spells an `id: { in: … }` is this
//      one — list-membership queries elsewhere are a different question, named as such.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, countCodeMentions, functionBody } from "./route-handlers";
import { crowdWhere, namedLeads } from "../../src/lib/lead-crowd";
import { ENRICHMENT_PROVIDERS } from "../../src/lib/enrichment-providers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const crowd = at("../../src/lib/lead-crowd.ts");
const validator = at("../../src/lib/validator.ts");
const enrichment = at("../../src/lib/enrichment.ts");
const scheduler = at("../../src/lib/scheduler.ts");
const leadRoute = at("../../src/app/api/leads/[id]/route.ts");
const ruleRunRoute = at("../../src/app/api/enrichment-rules/[id]/route.ts");

/** The slice of source around the first occurrence of `needle`. */
function around(text: string, needle: string, width: number): string {
  const i = text.indexOf(needle);
  assert.notEqual(i, -1, `${needle} must be present for this claim to mean anything`);
  return text.slice(i, i + width);
}

describe("namedLeads: every shape a caller can write", () => {
  it("calls anything that is not a list ‘not named’", () => {
    for (const value of [undefined, null, 0, "", "lead_1", true, {}, { id: "lead_1" }, [], {}]) {
      assert.equal(namedLeads(value), null, `${JSON.stringify(value)} is not a crowd`);
    }
  });

  it("keeps the words and drops everything else", () => {
    assert.deepEqual(namedLeads([42, null, undefined, "", "   ", {}, [], "lead_1", "lead_2"]), ["lead_1", "lead_2"]);
  });

  it("trims and folds, the way a provider list is", () => {
    assert.deepEqual(namedLeads([" lead_1 ", "lead_1", "lead_2"]), ["lead_1", "lead_2"], "one person named twice");
    assert.deepEqual(namedLeads(["lead_2", "lead_1"]), ["lead_2", "lead_1"], "the caller’s order is kept");
  });

  it("does not cap the crowd it was given", () => {
    const many = Array.from({ length: 1000 }, (_, i) => `lead_${i}`);
    assert.equal(namedLeads(many)?.length, 1000, "the query’s `take` is the bound, not this reader");
  });
});

describe("crowdWhere: naming narrows, never replaces", () => {
  it("leaves an unnamed job exactly the where it had", () => {
    const base = { workspaceId: "ws_1", status: { in: ["NEW"] } };
    assert.deepEqual(crowdWhere(base, null), base);
  });

  it("adds the ids beside the scope, keeping every key it was handed", () => {
    const base = { workspaceId: "ws_1", seniority: { in: ["VP"] }, tags: { has: ["vip"] } };
    assert.deepEqual(crowdWhere(base, ["lead_1", "lead_2"]), {
      workspaceId: "ws_1",
      seniority: { in: ["VP"] },
      tags: { has: ["vip"] },
      id: { in: ["lead_1", "lead_2"] },
    });
  });

  it("is a narrowing the tenant key cannot be lost from", () => {
    const scoped = crowdWhere({ workspaceId: "ws_1" }, ["someone-else’s-lead"]);
    assert.equal(scoped.workspaceId, "ws_1", "the job’s own workspace, whichever way the crowd goes");
    assert.deepEqual(scoped.id, { in: ["someone-else’s-lead"] }, "and the id, which together select nobody");
  });

  it("replaces a bare id rather than merging two answers", () => {
    assert.deepEqual(crowdWhere({ id: "lead_stale" }, ["lead_1"]), { id: { in: ["lead_1"] } });
  });
});

describe("the wiring, from the source", () => {
  it("has the validator reading the shared module rather than its own copy", () => {
    assert.ok(countCodeMentions(validator, "lead-crowd") >= 1, "it imports the module");
    assert.ok(!/function namedLeads/.test(blankComments(validator)), "and no longer declares one");
    const body = blankComments(functionBody(validator, "runValidateJob")!);
    assert.match(body, /where: crowdWhere\(\{ workspaceId: job\.workspaceId \}, namedLeads\(config\.leadIds\)\)/);
    assert.equal(countCodeMentions(body, "prisma.lead.findMany"), 1, "one crowd, read once");
  });

  it("has the enrichment worker read the same reader", () => {
    assert.ok(countCodeMentions(enrichment, "lead-crowd") >= 1);
    const body = blankComments(functionBody(enrichment, "getLeadsToEnrich")!);
    assert.match(body, /const crowd = namedLeads\(config\.leadIds\)/);
    assert.match(body, /crowdWhere\(leadWhere\(workspaceId, stored\.conditions\), crowd\)/);
    assert.ok(/leadIds\?: unknown/.test(enrichment), "the config declares the field, untrusted as any job blob");
  });

  it("makes the door that names a lead in its URL carry that name into the job", () => {
    const body = blankComments(functionBody(leadRoute, "POST_impl")!);
    const enrich = body.slice(body.indexOf('action === "enrich"'), body.indexOf('action === "add-to-list"'));
    assert.match(enrich, /leadIds: \[id\]/, "the id in the URL is the crowd");
    assert.match(enrich, /totalItems: 1/, "and the row says so");
    assert.match(enrich, /workspaceId: _owned\.workspaceId/, "the job is queued in the workspace that owns the lead");
    assert.match(enrich, /assertOwns\(request, _owned\.workspaceId\)/, "refused before any of it if it does not");
  });

  it("lists, for that visit, only providers this build can answer with", () => {
    const body = blankComments(functionBody(leadRoute, "POST_impl")!);
    const enrich = body.slice(body.indexOf('action === "enrich"'), body.indexOf('action === "add-to-list"'));
    const listed = /providers: \[([^\]]*)\]/.exec(enrich)?.[1] ?? "";
    const names = listed.split(",").map((one) => one.trim().replace(/"/g, "")).filter(Boolean);
    assert.deepEqual(names, ["derive"], "the keyless box has one provider that answers");
    for (const name of names) assert.ok(ENRICHMENT_PROVIDERS.includes(name as (typeof ENRICHMENT_PROVIDERS)[number]), `${name} is dispatched`);
    assert.ok(!/apollo|clearbit|hunter/.test(enrich), "the keyed names belong to the rule door");
  });

  it("carries the ids the bulk queue and the scheduler counted, not just their count", () => {
    // Read from the job write itself: `functionBody` closes the slice at the first
    // unbalanced `)`, which `asInputJson({ … })` and the ternary in the scheduler’s
    // config both create, and a truncated slice would pass these by never reaching them.
    const bulk = blankComments(around(enrichment, 'type: "ENRICH"', 600));
    assert.match(bulk, /config: asInputJson\(\{ \.\.\.config, leadIds \}\)/);
    assert.match(bulk, /totalItems: leadIds\.length/);
    const tick = blankComments(around(scheduler, 'type: "ENRICH"', 600));
    assert.match(tick, /leadIds: leads\.map\(\(lead\) => lead\.id\)/);
    assert.match(tick, /totalItems: leads\.length/);
  });

  it("leaves a rule run meaning the rule's whole crowd", () => {
    const body = blankComments(functionBody(ruleRunRoute, "POST_impl")!);
    assert.ok(!/leadIds/.test(around(body, 'type: "ENRICH"', 700)), "?action=run names no crowd — the conditions do");
  });
});

describe("one module builds a job's crowd", () => {
  // The claim is about the modules that pick the people a background job walks, not
  // about every `IN` list in the product: `lead-lists/[id]` and `POST /api/leads`
  // build `id: { in: … }` / `leadListId` membership queries of their own, which are
  // reads of a list, not a crowd a worker was told to visit.
  const jobPath = [
    "src/lib/lead-crowd.ts",
    "src/lib/validator.ts",
    "src/lib/enrichment.ts",
    "src/lib/scheduler.ts",
    "src/lib/queue.ts",
    "src/app/api/leads/[id]/route.ts",
    "src/app/api/enrichment-rules/[id]/route.ts",
  ];

  it("has no module on the job path hand-writing an `id: { in: … }`", () => {
    const offenders: string[] = [];
    for (const rel of jobPath) {
      if (rel.endsWith("lead-crowd.ts")) continue;
      if (/id:\s*\{\s*in:/.test(blankComments(at(`../../${rel}`)))) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], "every named crowd goes through `crowdWhere`");
  });

  it("is the only source of that clause", () => {
    assert.match(blankComments(crowd), /return crowd === null \? base : \{ \.\.\.base, id: \{ in: crowd \} \}/);
    for (const rel of jobPath.slice(1)) {
      const code = blankComments(at(`../../${rel}`));
      if (/crowdWhere\(/.test(code)) {
        assert.ok(/lead-crowd/.test(code), `${rel} narrows with crowdWhere and imports it from lead-crowd`);
      }
    }
  });
});
