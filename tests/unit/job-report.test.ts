// #40 — a finished job row says what it did: the percentage computed from the
// counters that produced it, the case with no denominator named instead of claimed,
// and one `JobResult` row for every row a worker made a decision about.
//
// Measured against the running app before any of this shipped. 475 `Job` rows, 466
// of them COMPLETED, and every one reporting `progress: 100` — typed, in all five
// workers, at the finish line. 386 of those rows also report `totalItems: 0` while
// reporting `processedItems: 16`: the workers held the crowd size in a local and
// wrote it into no column, so the row says it completed 100% of nothing. Five more
// report COMPLETED with `failedItems > 0`, which is true and unstated because
// `Job.status` has no value between COMPLETED and FAILED. And `JobResult` — the
// table `GET /api/jobs/{id}` includes as `results`, and which the same route's own
// docs promise — held **0 rows across all 475 jobs**, because nothing in `src/` had
// ever written one. The detail door was permanently, structurally empty.
//
// So this file pins: the arithmetic, the words for the unmeasurable case, the shape
// of a per-item record and what it refuses to leave out, the reading of an enrichment
// visit that reached a row and wrote nothing (which of the plan's three gates fired,
// from the sets rather than from one fitted sentence), the derived verdict, the
// reading `GET /api/jobs/{id}` hands back, and the wiring — four workers computing
// their own percentage, three of them writing the records they already decide, the
// two doors that must record a removal before they delete the row it names, and a
// census that knows exactly which worker still types 100 and why.
//
// Nothing here needs a browser, a database or a network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import {
  NO_DENOMINATOR,
  RESULT_STATUSES,
  countersProblem,
  enrichmentVisit,
  handled,
  jobReport,
  jobResultRow,
  progressOf,
  progressValue,
  verdictFor,
} from "../../src/lib/job-report";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });

const enrichment = blankComments(at("../../src/lib/enrichment.ts"));
const validator = blankComments(at("../../src/lib/validator.ts"));
const exporter = blankComments(at("../../src/lib/exporter.ts"));
const dedupe = blankComments(at("../../src/lib/dedupe.ts"));
const scraper = blankComments(at("../../src/lib/scraper.ts"));
const detailRoute = at("../../src/app/api/jobs/[id]/route.ts");
const schema = at("../../prisma/schema.prisma");

/** The row this instance actually held: 386 of them, to the digit. */
const UNMEASURED_ROW = { status: "COMPLETED", progress: 100, totalItems: 0, processedItems: 16, failedItems: 0 };
/** The same job as its worker held it: three counters, no status. */
const UNMEASURED_RUN = { total: 0, processed: 16, failed: 0 };

describe("the percentage is arithmetic", () => {
  it("reports the share of a crowd that was walked", () => {
    assert.deepEqual(progressOf({ total: 16, processed: 16, failed: 0 }), { measured: true, percent: 100, reason: null });
    assert.deepEqual(progressOf({ total: 16, processed: 8, failed: 0 }), { measured: true, percent: 50, reason: null });
    assert.deepEqual(progressOf({ total: 16, processed: 0, failed: 0 }), { measured: true, percent: 0, reason: null });
  });

  it("rounds, and does not round up out of thin air", () => {
    assert.equal(progressValue({ total: 3, processed: 1, failed: 0 }), 33);
    assert.equal(progressValue({ total: 3, processed: 2, failed: 0 }), 67);
  });

  it("counts a row it could not finish as a row it got to", () => {
    // Progress measures the sweep, the verdict measures the outcome. A job that
    // visited all 16 and could not finish 2 of them was through the whole crowd,
    // and `verdictFor` is where the 2 are said out loud.
    assert.deepEqual(progressOf({ total: 16, processed: 14, failed: 2 }), { measured: true, percent: 100, reason: null });
  });

  it("refuses to take a percentage of nothing", () => {
    const reading = progressOf({ total: 0, processed: 0, failed: 0 });
    assert.equal(reading.measured, false);
    assert.equal(reading.percent, 0, "0 is the value that claims least, not a report that nothing was done");
    assert.equal(reading.reason, NO_DENOMINATOR);
    assert.match(reading.reason ?? "", /no denominator/);
  });

  it("clamps a job that accounted for more rows than it counted", () => {
    assert.equal(progressValue({ total: 4, processed: 9, failed: 0 }), 100);
  });

  it("coerces a counter that is not a row count", () => {
    assert.equal(progressValue({ total: Number.NaN, processed: 3, failed: 1 }), 0);
    assert.equal(progressValue({ total: -5, processed: 3, failed: 1 }), 0);
    assert.equal(handled({ total: 10, processed: 2.9, failed: -3 }), 2);
  });

  it("is the function the workers call, not a number they compare themselves to", () => {
    assert.equal(progressValue({ total: 200, processed: 100, failed: 100 }), 100);
    assert.equal(progressValue({ total: 200, processed: 100, failed: 0 }), 50);
  });
});

describe("a row whose own numbers disagree says which ones", () => {
  it("names the 386-row shape", () => {
    const problem = countersProblem({ total: 0, processed: 16, failed: 0 });
    assert.ok(problem, "16 of 0 is not a completed job, it is a contradiction");
    assert.match(problem, /16 row\(s\) accounted for against a denominator of 0/);
  });

  it("leaves a consistent row alone", () => {
    assert.equal(countersProblem({ total: 16, processed: 15, failed: 1 }), null);
    assert.equal(countersProblem({ total: 0, processed: 0, failed: 0 }), null, "nothing promised, nothing done");
  });

  it("names a finished job that accounted for none of its crowd", () => {
    const problem = countersProblem({ total: 12, processed: 0, failed: 0 });
    assert.ok(problem);
    assert.match(problem, /nothing accounted for/);
  });

  it("does not invent a problem out of a partial", () => {
    assert.equal(countersProblem({ total: 16, processed: 14, failed: 2 }), null, "failures are a verdict, not a contradiction");
  });
});

describe("a per-item record leaves out nothing it claims", () => {
  it("passes a success through", () => {
    const row = jobResultRow("job-1", { leadId: "lead-1", status: "SUCCESS", data: { writtenColumns: ["title"] } });
    assert.equal(row.jobId, "job-1");
    assert.equal(row.leadId, "lead-1");
    assert.equal(row.status, "SUCCESS");
    assert.equal(row.error, null);
    assert.deepEqual(row.data, { writtenColumns: ["title"] });
  });

  it("keeps the identity of a row that no longer exists to point at", () => {
    const row = jobResultRow("job-1", { leadId: null, status: "SUCCESS", data: { duplicateId: "lead-9" } });
    assert.equal(row.leadId, null);
  });

  it("refuses to record a failure it cannot explain", () => {
    assert.match(jobResultRow("j", { leadId: "l", status: "FAILED" }).error ?? "", /no reason captured/);
    assert.match(jobResultRow("j", { leadId: "l", status: "FAILED", error: "   " }).error ?? "", /no reason captured/);
  });

  it("keeps the reason a failure did give", () => {
    assert.equal(jobResultRow("j", { leadId: "l", status: "FAILED", error: " P2025: row gone " }).error, "P2025: row gone");
  });

  it("refuses to record a skip with no reason", () => {
    const row = jobResultRow("j", { leadId: "l", status: "SKIPPED", data: { asked: ["apollo"] } });
    assert.match(String((row.data as Record<string, unknown>).reason), /no reason recorded/);
    assert.deepEqual((row.data as Record<string, unknown>).asked, ["apollo"], "what it did say survives");
  });

  it("does not overwrite a reason it was given", () => {
    const row = jobResultRow("j", { leadId: "l", status: "SKIPPED", data: { reason: "no provider answered" } });
    assert.equal((row.data as Record<string, unknown>).reason, "no provider answered");
  });

  it("turns a status outside the schema's set into a failure rather than a new word", () => {
    const row = jobResultRow("j", { leadId: "l", status: "MAYBE" as never });
    assert.equal(row.status, "FAILED");
    assert.match(row.error ?? "", /no reason captured/);
  });

  it("is the only shape the status column is written from", () => {
    assert.deepEqual([...RESULT_STATUSES], ["SUCCESS", "FAILED", "SKIPPED"]);
    const declared = /model JobResult \{[^}]*status\s+String\s+\/\/ (.*)/m.exec(schema);
    assert.deepEqual(
      (declared?.[1] ?? "").split("|").map((word) => word.trim()),
      [...RESULT_STATUSES],
      "the schema comment and the set this module writes are one list",
    );
  });
});

describe("the verdict says what a status cannot", () => {
  it("calls a completed job with failures partial, and says the word is derived", () => {
    const verdict = verdictFor("COMPLETED", { total: 16, processed: 14, failed: 2 });
    assert.equal(verdict.verdict, "COMPLETED", "the stored status is not rewritten");
    assert.match(verdict.note ?? "", /partial: 2 of 16/);
    assert.match(verdict.note ?? "", /Derived here/);
  });

  it("says unmeasurable rather than inventing a percentage for a completed job", () => {
    const verdict = verdictFor("COMPLETED", UNMEASURED_RUN);
    assert.equal(verdict.verdict, "COMPLETED");
    assert.match(verdict.note ?? "", /not measurable from this row/);
  });

  it("tells a cancelled job what it already wrote", () => {
    const verdict = verdictFor("CANCELLED", { total: 16, processed: 4, failed: 0 });
    assert.match(verdict.note ?? "", /4 row\(s\) were already written/);
    assert.match(verdict.note ?? "", /nothing in this application stops a worker/);
  });

  it("has nothing to add to a clean finish or a row still going", () => {
    assert.equal(verdictFor("COMPLETED", { total: 16, processed: 16, failed: 0 }).note, null);
    assert.deepEqual(verdictFor("RUNNING", { total: 16, processed: 3, failed: 0 }), { verdict: "RUNNING", note: null });
  });
});

describe("what GET /api/jobs/{id} hands back beside the row", () => {
  it("reads the stored 100 as unmeasured when the row denies having a denominator", () => {
    const report = jobReport(UNMEASURED_ROW, 0, 0);
    assert.equal(report.measured, false);
    assert.equal(report.percent, 0, "the typed 100 is not echoed back as a fact");
    assert.equal(report.reason, NO_DENOMINATOR);
    assert.ok(report.problem, "16 rows of work against a total of 0 is named");
  });

  it("counts the records instead of inferring them from the page it returned", () => {
    assert.deepEqual(jobReport(UNMEASURED_ROW, 50, 50).results, { recorded: 50, returned: 50, truncated: false });
    assert.deepEqual(jobReport({ ...UNMEASURED_ROW, totalItems: 4000, progress: 100 }, 4000, 50).results, {
      recorded: 4000,
      returned: 50,
      truncated: true,
    });
  });

  it("reports a job that did measure itself as measured", () => {
    const report = jobReport({ status: "COMPLETED", progress: 100, totalItems: 16, processedItems: 16, failedItems: 0 }, 16, 16);
    assert.equal(report.measured, true);
    assert.equal(report.percent, 100);
    assert.equal(report.problem, null);
    assert.equal(report.verdictNote, null);
  });
});

describe("the workers compute the number instead of typing it", () => {
  const finishers: [string, string][] = [
    ["runEnrichmentJob", enrichment],
    ["runValidateJob", validator],
    ["runExportJob", exporter],
    ["runDedupeJob", dedupe],
  ];

  for (const [name, source] of finishers) {
    it(`${name} reaches its terminal write through the arithmetic`, () => {
      const body = functionBody(source, name)!;
      assert.ok(!/progress: 100/.test(body), `${name} still types the answer`);
      assert.match(body, /progress: progressValue\(/);
    });
  }

  it("writes the denominator it computed the share from", () => {
    assert.match(functionBody(validator, "runValidateJob")!, /totalItems: leads\.length/);
    assert.match(functionBody(exporter, "runExportJob")!, /totalItems: leads\.length/);
    assert.match(functionBody(enrichment, "runEnrichmentJob")!, /totalItems: leads\.length/);
  });

  it("says how far along it is while it is still going, not only at the end", () => {
    const body = functionBody(enrichment, "runEnrichmentJob")!;
    const inLoop = body.slice(0, body.indexOf('status: "COMPLETED"'));
    assert.equal(inLoop.split("progress: progressValue(").length - 1, 1, "the per-row write is computed too");
  });

  it("leaves exactly one worker typing 100, and that worker cannot run here", () => {
    const typers = srcFiles(srcDir).filter((file) => /progress: 100/.test(blankComments(readFileSync(file, "utf8"))));
    assert.deepEqual(
      typers.map((file) => file.replace(srcDir + "/", "")),
      ["lib/scraper.ts"],
      "SCRAPE's terminal write is unreachable on an instance with no browser, so no change to it is checkable here",
    );
    assert.match(scraper, /totalSaved, failedItems: errors/);
  });
});

describe("a visit that wrote nothing says which gate stopped it", () => {
  const visit = (over: Partial<Parameters<typeof enrichmentVisit>[1]>) =>
    enrichmentVisit("lead-1", { lead: {}, named: [], answered: [], written: [], declaredFields: [], ...over });

  it("calls a visit that landed a column a success", () => {
    const outcome = visit({ lead: { seniority: null }, named: ["seniority"], answered: ["seniority"], written: ["seniority"] });
    assert.equal(outcome.status, "SUCCESS");
    assert.deepEqual(outcome.data?.writtenColumns, ["seniority"]);
    assert.deepEqual(outcome.data?.answeredColumns, ["seniority"], "a success still names what came back");
  });

  it("names the reply that contained no column as itself", () => {
    const outcome = visit({ named: [], answered: [] });
    assert.equal(outcome.status, "SKIPPED");
    assert.match(String(outcome.data?.reason), /^the providers replied, and their answer named no column at all$/);
    assert.equal(outcome.data?.answeredColumns, undefined, "there is no set to print beside it");
  });

  it("blames the rule, not the provider, when the narrowing emptied the answer", () => {
    const outcome = visit({ named: ["email"], answered: [], declaredFields: ["seniority"] });
    assert.equal(outcome.status, "SKIPPED");
    assert.match(String(outcome.data?.reason), /the providers named `email` and none of it is a column this rule declared/);
    assert.deepEqual(outcome.data?.answeredColumns, ["email"], "what was named is not the same set as what was allowed");
    assert.deepEqual(outcome.data?.declaredFields, ["seniority"]);
  });

  it("says the row kept its own value when that is the only gate that fired", () => {
    const outcome = visit({ lead: { seniority: "Director" }, named: ["seniority"], answered: ["seniority"], written: [] });
    assert.deepEqual(outcome.data?.alreadyHeld, ["seniority"]);
    assert.deepEqual(outcome.data?.refusedForShape, []);
    assert.equal(outcome.data?.reason, "the row already held `seniority`");
  });

  it("separates a column that does not exist from one that refused the shape", () => {
    const outcome = visit({
      lead: { seniority: "Director", technologies: [], confidence: undefined },
      named: ["seniority", "technologies", "confidence"],
      answered: ["seniority", "technologies", "confidence"],
      written: [],
    });
    assert.deepEqual(outcome.data?.notAColumn, ["confidence"], "ENRICH_WRITABLE has no place for it");
    assert.deepEqual(outcome.data?.alreadyHeld, ["seniority"]);
    assert.deepEqual(outcome.data?.refusedForShape, ["technologies"], "an empty list is not a value the column takes");
    assert.equal(
      outcome.data?.reason,
      "`confidence` is not a column a lead row has; the row already held `seniority`; `technologies` came back in a shape its column does not accept",
    );
  });

  it("asks the plan's own predicate, so two readings of \"already held\" cannot disagree", () => {
    const source = blankComments(at("../../src/lib/job-report.ts"));
    assert.match(source, /import \{ ENRICH_WRITABLE, holds \} from "\.\/enrich-plan"/);
    assert.ok(!/function holds\(/.test(source), "the module does not re-decide what the plan decides");
  });

  it("keeps what the providers named apart from what the rule allowed through", () => {
    // The narrowed answer on its own cannot tell a refusal from silence, which is the
    // difference between "the rule did not ask for it" and "nobody said anything".
    const body = functionBody(enrichment, "enrichLead")!;
    assert.match(body, /return \{ named: Object\.keys\(results\), columns: restrictToDeclared\(results, config\.fields\) \}/);
  });
});

describe("the records are written where an outcome is decided", () => {
  it("exists in the three workers that decide something per row", () => {
    for (const [file, source] of [["enrichment", enrichment], ["validator", validator], ["dedupe", dedupe]] as const) {
      assert.match(source, /prisma\.jobResult\.create/, `${file} must write the record`);
    }
  });

  it("is every worker's record built by the module, never by hand", () => {
    for (const file of srcFiles(srcDir)) {
      const source = blankComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/prisma\.jobResult\.create\(\{[\s\S]{0,120}/g)) {
        assert.match(match[0], /data: jobResultRow\(/, `${file} shapes a JobResult without the module`);
      }
    }
  });

  it("names an enrichment that wrote nothing for what it was", () => {
    const body = functionBody(enrichment, "runEnrichmentJob")!;
    assert.match(body, /jobResultRow\(jobId, enrichmentVisit\(lead\.id, \{/, "the module decides, the worker supplies the sets");
    assert.match(body, /named: answer\.named,/);
    assert.match(body, /answered: Object\.keys\(answer\.columns\),/);
    assert.ok(!/status: "SUCCESS"/.test(body), "no worker hands out a SUCCESS any more");
    assert.match(body, /else \{\s*await prisma\.jobResult\.create/, "no answer at all is a record too");
    assert.match(body, /status: "FAILED"/);
  });

  it("hands the worker the columns, not a count of them", () => {
    assert.match(functionBody(enrichment, "updateLeadEnrichment")!, /return plan\.written;/);
    assert.match(enrichment, /\): Promise<string\[\]> \{/);
    assert.match(functionBody(enrichment, "runEnrichmentJob")!, /if \(written\.length > 0\) enriched\+\+/, "the enriched count means the same as it did");
  });

  it("records a removal before it deletes the row the record names", () => {
    const body = functionBody(validator, "runValidateJob")!;
    const recorded = body.indexOf("prisma.jobResult.create");
    const deleted = body.indexOf("prisma.lead.delete");
    assert.ok(recorded < deleted, "after the delete the id exists only in the payload");
    assert.match(body, /removedLeadId: lead\.id/);
  });

  it("does not point a record at a duplicate the merge has already deleted", () => {
    const body = functionBody(dedupe, "runDedupeJob")!;
    assert.match(body, /leadId: \(config\.action \|\| "merge"\) === "flag" \? dup\.id : null/);
    assert.match(body, /duplicateId: dup\.id/);
    assert.ok(body.indexOf("await mergeRecords(") < body.indexOf("prisma.jobResult.create"), "recorded once the merge actually happened");
  });

  it("outlives the lead it describes, in the database's own words", () => {
    const migration = at("../../prisma/migrations/20261016100000_init_postgres/migration.sql");
    assert.match(migration, /FOREIGN KEY \("leadId"\) REFERENCES "Lead"\("id"\) ON DELETE SET NULL/);
    assert.match(schema, /lead\s+Lead\?\s+@relation\(fields: \[leadId\], references: \[id\], onDelete: SetNull\)/);
  });

  it("leaves the two workers with nothing per-row to say alone", () => {
    assert.ok(!/jobResult/.test(exporter), "every row the filter matched went into the file, so a record per row would repeat itself");
    assert.ok(!/jobResult/.test(scraper), "and SCRAPE cannot be run on this instance to decide what its records should hold");
  });
});

describe("the detail door reads through the module", () => {
  it("counts the records before it answers", () => {
    const body = functionBody(detailRoute, "GET_impl")!;
    assert.ok(body.indexOf('prisma.jobResult.count') < body.indexOf("jobReport("), "truncation is measured, not guessed");
    assert.match(body, /where: \{ jobId: id \}/, "and counted for this job only");
  });

  it("adds the reading to the row instead of replacing it", () => {
    const body = functionBody(detailRoute, "GET_impl")!;
    assert.match(body, /\.\.\.job, report: jobReport\(job, recorded, job\.results\.length\)/);
    assert.match(body, /take: 50/, "the newest 50 still ride along");
  });

  it("cannot be fed a forged denominator", () => {
    const fields = blankComments(at("../../src/lib/fields.ts"));
    for (const name of ["JOB_CREATE", "JOB_PATCH"] as const) {
      const literal = new RegExp(`export const ${name} = \\{[\\s\\S]*?\\} satisfies Schema;`).exec(fields)?.[0];
      assert.ok(literal, `${name} is a schema literal this check can read`);
      for (const column of ["progress", "totalItems", "processedItems", "failedItems"]) {
        assert.ok(!new RegExp(`\\b${column}\\b\\s*:`).test(literal!), `no caller of ${name} may write ${column}`);
      }
    }
  });
});

describe("the module owns the words", () => {
  it("vends one sentence for the unmeasured case", () => {
    assert.match(NO_DENOMINATOR, /^not measured: /);
    const report = jobReport(UNMEASURED_ROW, 0, 0);
    assert.equal(report.reason, NO_DENOMINATOR, "the door and the worker read it from the same constant");
  });

  it("is imported by every worker that computes, and by the door", () => {
    for (const [file, source] of [["enrichment", enrichment], ["validator", validator], ["exporter", exporter], ["dedupe", dedupe]] as const) {
      assert.match(source, /from "\.\/job-report"/, `${file} must import the arithmetic`);
    }
    assert.match(detailRoute, /from "@\/lib\/job-report"/);
  });

  it("writes no job row of its own", () => {
    const source = at("../../src/lib/job-report.ts");
    assert.ok(!/prisma\./.test(source), "the arithmetic decides; a worker does the writing");
    assert.equal(srcFiles(srcDir).filter((f) => f.endsWith("job-report.ts")).length, 1);
  });
});
