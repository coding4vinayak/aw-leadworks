// #41 — a mark an operator made is obeyed by the worker that is running.
//
// Measured on this instance before any of this shipped: `?action=cancel` is in the
// README's API list since the first commit, `POST /api/jobs/{id}?action=cancel` writes
// the mark and `completedAt` and answers `{ ok: true }`, and **nothing in `src/` read
// the mark back** — not one of the four workers that can finish here. The table said
// 475 `Job` rows, 466 COMPLETED and **0 CANCELLED**: a door no one could walk through is
// a door no one uses. And the reading shipped last round had to print, beside a
// cancelled row, *nothing in this application stops a worker that is running* — the
// honest sentence about the code. This round is what makes it false.
//
// So this file pins: which status is a mark and which row holds it; the split a stop
// leaves behind (the rows reached are not the rows failed); what a marked row may not be
// accused of; the write that obeys it, including the status it refuses to overwrite; and
// the wiring — three workers reading the mark between rows, no event claiming a finish
// that did not happen, and a census that knows exactly which two files still do not
// consult it and why, so the next round has to change this test rather than drift past it.
//
// Nothing here needs a browser, a database or a network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import {
  MARK,
  isMarked,
  startWrite,
  stoppedWrite,
} from "../../src/lib/job-stop";
import {
  countersProblem,
  jobReport,
  progressValue,
  stopAt,
  stopNote,
  verdictFor,
} from "../../src/lib/job-report";
import { JOB_STATUSES } from "../../src/lib/enums";
import { WEBHOOK_EVENTS } from "../../src/lib/webhooks";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });
/** Every `src/` file whose code (not prose) mentions a string, by repo-relative path. */
const mentioners = (needle: string): string[] =>
  srcFiles(srcDir)
    .filter((file) => blankComments(readFileSync(file, "utf8")).includes(needle))
    .map((file) => file.replace(/.*\/src\//, "src/"))
    .sort();
const stopSource = blankComments(at("../../src/lib/job-stop.ts"));
const enrichment = blankComments(at("../../src/lib/enrichment.ts"));
const validator = blankComments(at("../../src/lib/validator.ts"));
const dedupe = blankComments(at("../../src/lib/dedupe.ts"));
const exporter = blankComments(at("../../src/lib/exporter.ts"));
const detailRoute = at("../../src/app/api/jobs/[id]/route.ts");
const schema = at("../../prisma/schema.prisma");

const STOPPED_MID_RUN = { total: 16, processed: 4, failed: 0 };
const STOPPED_BEFORE_START = { total: 16, processed: 0, failed: 0 };

describe("the mark is one status, and the row that holds it", () => {
  it("is obeyed for exactly the one word", () => {
    assert.equal(isMarked({ status: "CANCELLED" }), true);
    for (const status of ["PENDING", "RUNNING", "COMPLETED", "FAILED"]) {
      assert.equal(isMarked({ status }), false, `${status} is not a mark a worker stops for`);
    }
  });

  it("is not a missing row", () => {
    // A deleted job took its records with it. Absence is not permission to stop,
    // because the next write would be a terminal status on a row that is not there.
    assert.equal(isMarked(null), false);
    assert.equal(isMarked(undefined), false);
  });

  it("is a word the stored set already has, so no migration is asked for", () => {
    assert.equal((JOB_STATUSES as readonly string[]).includes(MARK), true, "the door and the worker read one list");
    assert.match(
      schema,
      /status\s+String\s+@default\("PENDING"\)\s+\/\/ PENDING \| RUNNING \| COMPLETED \| FAILED \| CANCELLED/,
      "and the schema's own comment line names it",
    );
  });

  it("asks the report's own arithmetic rather than keeping a second copy", () => {
    assert.match(stopSource, /import \{ counter, progressValue \} from "\.\/job-report"/);
    assert.ok(!/Math\.round\(/.test(stopSource), "a percentage lives in one file");
    assert.ok(!/Math\.max\(0, Math\.trunc/.test(stopSource), "and so does the clamp a column needs");
  });
});

describe("what a stop leaves behind", () => {
  it("separates the rows it reached from the rows it never saw", () => {
    assert.deepEqual(stopAt(STOPPED_MID_RUN), { total: 16, reached: 4, left: 12 });
  });

  it("counts a refused row as reached, because the job did visit it", () => {
    assert.deepEqual(stopAt({ total: 20, processed: 5, failed: 1 }), { total: 20, reached: 6, left: 14 });
  });

  it("cannot be told a bigger story than the denominator", () => {
    // The 16-of-0 shape #40 left alone: a stop reading it says "all of nothing was
    // reached", not "there were 14 more rows waiting".
    assert.deepEqual(stopAt({ total: 10, processed: 14, failed: 0 }), { total: 10, reached: 10, left: 0 });
  });

  it("says zero for a row that stamped no denominator", () => {
    assert.deepEqual(stopAt({ total: 0, processed: 0, failed: 0 }), { total: 0, reached: 0, left: 0 });
  });

  it("names the middle of a run: what it accounted for, and the rest it never reached", () => {
    const note = stopNote(STOPPED_MID_RUN);
    assert.match(note, /stopped at the mark with 4 of 16 row\(s\) accounted for/);
    assert.match(note, /12 row\(s\) after it were never reached/);
    assert.match(note, /a row already in flight is finished, the next one is not started/);
  });

  it("says the quiet case in its own words rather than rounding it to zero work", () => {
    assert.match(
      stopNote(STOPPED_BEFORE_START),
      /the mark was read before the worker reached a row — 16 row\(s\) in its denominator, none visited, no record on any of them/,
    );
  });

  it("will not invent a share for a row that has no denominator", () => {
    assert.match(stopNote({ total: 0, processed: 0, failed: 0 }), /stamped no denominator/);
  });
});

describe("a row the operator stopped is not a row that contradicts itself", () => {
  it("forgives the one shape a stop produces legitimately", () => {
    assert.equal(countersProblem(STOPPED_BEFORE_START, "stopped"), null);
    assert.match(
      countersProblem(STOPPED_BEFORE_START) ?? "",
      /finished without saying it visited any row/,
      "the same numbers on a row that says it finished are still an accusation",
    );
  });

  it("forgives nothing about over-reporting", () => {
    assert.match(
      countersProblem({ total: 10, processed: 14, failed: 0 }, "stopped") ?? "",
      /against a denominator of 10/,
      "a mark is not a licence to smooth a contradiction away",
    );
  });

  it("hands a cancelled row the reading, not the sentence #40 had to print", () => {
    const verdict = verdictFor("CANCELLED", STOPPED_MID_RUN);
    assert.equal(verdict.verdict, "CANCELLED");
    assert.equal(verdict.note, stopNote(STOPPED_MID_RUN));
    assert.ok(!/nothing in this application stops a worker/.test(verdict.note ?? ""));
    const stillRunning = /nothing in this application stops a worker/.test(
      [enrichment, validator, dedupe, exporter, stopSource, detailRoute].join("\n"),
    );
    assert.equal(stillRunning, false, "and the sentence is gone from the tree, not merely from this branch");
  });
});

describe("the reading of a stopped row", () => {
  it("measures what it did and refuses to call the rest a failure", () => {
    const report = jobReport(
      { status: "CANCELLED", progress: progressValue({ total: 200, processed: 6, failed: 0 }), totalItems: 200, processedItems: 6, failedItems: 0 },
      6,
      6,
    );
    assert.equal(report.measured, true, "200 rows were counted, so there is a whole to take a share of");
    assert.equal(report.percent, 3);
    assert.equal(report.verdict, "CANCELLED");
    assert.equal(report.problem, null);
    assert.deepEqual(report.results, { recorded: 6, returned: 6, truncated: false });
  });

  it("keeps an unstarted stop measured, with the zero said as a share and not as a missing denominator", () => {
    const report = jobReport(
      { status: "CANCELLED", progress: 0, totalItems: 200, processedItems: 0, failedItems: 0 },
      0,
      0,
    );
    assert.equal(report.measured, true);
    assert.equal(report.reason, null);
    assert.equal(report.percent, 0);
    assert.match(report.verdictNote ?? "", /none visited/);
  });
});

describe("the write that obeys", () => {
  const at2 = new Date("2026-10-22T12:00:00.000Z");

  it("keeps the mark's own status instead of writing a word of its own", () => {
    const data = stoppedWrite(STOPPED_MID_RUN, at2);
    assert.equal(data.status, "CANCELLED", "a worker that stops does not upgrade the operator's word");
    assert.equal(data.completedAt, at2);
  });

  it("stamps the denominator it divided by, like every other finisher", () => {
    const data = stoppedWrite(STOPPED_MID_RUN, at2);
    assert.equal(data.totalItems, 16);
    assert.equal(data.processedItems, 4);
    assert.equal(data.failedItems, 0);
    assert.equal(data.progress, 25);
  });

  it("cannot say 100 about a run it stopped", () => {
    assert.equal(stoppedWrite({ total: 200, processed: 5, failed: 1 }, at2).progress, 3);
    assert.equal(stoppedWrite(STOPPED_BEFORE_START, at2).progress, 0);
    assert.equal(stoppedWrite({ total: 0, processed: 0, failed: 0 }, at2).progress, 0, "unmeasured is stored as the 0 that claims least");
  });

  it("begins with the worker's own word, never the operator's", () => {
    const at3 = new Date("2026-10-22T12:00:00.000Z");
    assert.deepEqual(startWrite(at3), { status: "RUNNING", startedAt: at3 });
    assert.notEqual(startWrite(at3).status, MARK, "a worker that begins does not speak for the door");
  });

  it("coerces a counter a row cannot hold", () => {
    const data = stoppedWrite({ total: -4, processed: 2.9, failed: Number.NaN }, at2);
    assert.deepEqual(
      { totalItems: data.totalItems, processedItems: data.processedItems, failedItems: data.failedItems },
      { totalItems: 0, processedItems: 2, failedItems: 0 },
    );
  });
});

describe("the workers read the mark between rows", () => {
  const workers: [string, string, string, string][] = [
    ["runEnrichmentJob", enrichment, "enrichLead(lead, config)", "jobId"],
    ["runValidateJob", validator, "validateLead(lead, config)", "job.id"],
    ["runDedupeJob", dedupe, "mergeRecords(master, dup", "job.id"],
  ];

  for (const [name, source, work, idRef] of workers) {
    it(`${name} asks the database before the row it is about to work on`, () => {
      const body = functionBody(source, name)!;
      const asked = body.indexOf(
        `isMarked(await prisma.job.findUnique({ where: { id: ${idRef} }, select: { status: true } }))`,
      );
      const began = body.indexOf(work);
      assert.ok(asked >= 0, `${name} must consult the mark with the row's own status`);
      assert.ok(began >= 0, `${name} must still do the work this test measures against`);
      assert.ok(asked < began, "the mark is read before the row is touched, never after");
    });

    it(`${name} writes the stop and the finish through the same arithmetic`, () => {
      const body = functionBody(source, name)!;
      assert.match(body, /stopped\s*\?\s*stoppedWrite\(counters, new Date\(\)\)/);
      assert.match(body, /const counters = \{ total:/);
      assert.ok(!/progress: 100/.test(body), "and neither branch types a 100");
    });
  }

  it("counts a duplicate it stopped in front of as never reached", () => {
    const body = functionBody(dedupe, "runDedupeJob")!;
    assert.ok(
      body.indexOf("isMarked(") < body.indexOf("duplicatesFound++"),
      "the denominator is what the job got in front of, so `left` is honest",
    );
    assert.match(body, /if \(stopped\) break;/, "and the stop leaves the group loop, not only the inner one");
  });

  it("refuses to begin over a mark, in all three, before the first row", () => {
    for (const [name, source, work] of workers) {
      const body = functionBody(source, name)!;
      const claim = body.indexOf("status: { not: MARK }");
      const began = body.indexOf("if (!began.count) return;");
      const first = body.indexOf(work);
      assert.ok(claim >= 0, `${name} must take the row over with the mark in its WHERE`);
      assert.ok(began >= 0, `${name} must give up when the database says the mark`);
      assert.ok(claim < began, "the refusal reads the claim, not a second query");
      assert.ok(began < first, `${name} must refuse to begin before it touches a row`);
      assert.match(body, /data: startWrite\(new Date\(\)\)/, "and the word it begins with is the module's");
      assert.ok(!/data: \{ status: "RUNNING"/.test(body), "no unconditional RUNNING write left in it");
    }
  });

  it("imports the mark from one file, in all three", () => {
    for (const [file, source] of [["enrichment", enrichment], ["validator", validator], ["dedupe", dedupe]] as const) {
      assert.match(source, /import \{[^}]*\bisMarked\b[^}]*\} from "\.\/job-stop"/, `${file} must obey through the module`);
    }
  });

  it("stops short of losing the records it already wrote", () => {
    const body = functionBody(enrichment, "runEnrichmentJob")!;
    const loop = body.indexOf("for (const lead of leads) {");
    const marked = body.indexOf("isMarked(");
    const record = body.indexOf("prisma.jobResult.create");
    const terminal = body.indexOf("const counters = {");
    assert.ok(loop >= 0 && loop < marked, "the mark is read inside the loop, once a row");
    assert.ok(marked < record, "and before the row is worked on, not after");
    assert.ok(record < terminal, "the terminal write sits past the loop, so a break leaves the records of the rows it did");
  });
});

describe("the mark outranks every word a worker writes", () => {
  const claims: [string, string][] = [
    ["runEnrichmentJob", enrichment],
    ["runValidateJob", validator],
    ["runDedupeJob", dedupe],
  ];

  for (const [name, source] of claims) {
    it(`${name} refuses to finish over a mark that landed mid-row`, () => {
      const body = functionBody(source, name)!;
      assert.match(body, /status: stopped \? MARK : \{ not: MARK \}/, "one write, with the mark in its WHERE either way");
      assert.ok(!/await prisma\.job\.update\(\{\s*where: \{ id: /.test(body), "no unconditional Job status write left in it");
      const repair = body.indexOf("if (!finish.count && !stopped) {");
      assert.ok(repair > body.indexOf("status: stopped ? MARK"), `${name} repairs the finish it was refused, after it`);
      assert.ok(
        body.slice(repair).includes("status: MARK }, data: stoppedWrite(counters"),
        `${name} repairs the refusal with the row's own mark and the counters it holds`,
      );
    });
  }

  it("counts a running enrichment as a share of its crowd, not a bare status", () => {
    const body = functionBody(enrichment, "runEnrichmentJob")!;
    assert.match(
      body,
      /updateMany\(\{\s*where: \{ id: jobId, status: \{ not: MARK \} \},\s*data: \{[\s\S]{0,240}?totalItems: leads\.length/,
      "the per-lead stamp carries the denominator it is dividing by",
    );
    assert.ok(
      body.indexOf("totalItems: leads.length,\n        progress: progressValue({ total: leads.length") <
        body.indexOf("const counters = {"),
      "and it is the loop's write, one statement that cannot walk a mark back to RUNNING",
    );
  });

  it("does not let an error outrank the operator's word", () => {
    assert.match(
      functionBody(dedupe, "runDedupeJob")!,
      /catch \(error\) \{[\s\S]*?where: \{ id: job\.id, status: \{ not: MARK \} \},[\s\S]*?status: "FAILED"/,
      "a worker that threw writes FAILED only over a row that never got marked",
    );
  });
});

describe("a stopped job tells nobody a finish it did not have", () => {
  it("holds the `enrichment.completed` dispatch behind the stop", () => {
    const body = functionBody(enrichment, "runEnrichmentJob")!;
    const guard = body.indexOf("if (!stopped) {");
    const sent = body.indexOf('dispatchWebhookEvent(job.workspaceId, "enrichment.completed"');
    assert.ok(guard >= 0 && sent > guard, "the event is inside the guard, not after it");
    assert.ok(body.slice(sent).indexOf("}") < 400, "one guard, one call");
  });

  it("has no fourth event name to invent, which is why the guard is the honest shape", () => {
    assert.deepEqual([...WEBHOOK_EVENTS], ["lead.created", "enrichment.completed", "export.completed"]);
  });
});

describe("what this round left alone, pinned so it cannot drift silently", () => {
  it("leaves exactly four workers obeying the mark, and one door asking for its word", () => {
    // #42 added an importer that is not a worker at all: `lib/job-retry.ts` takes `MARK` so the
    // resume accepts the status rather than spelling it out again — it holds no query and no
    // write. #43 adds the fourth *worker*: `lib/exporter.ts`, the file #41 named as left alone
    // and #42's own honesty bullets named again, which stamped `RUNNING` and then `COMPLETED`
    // over an operator's mark in the 139 ms between its two unconditional writes. One file is
    // still out, for the reason the test below keeps.
    assert.deepEqual(mentioners("./job-stop"), [
      "src/lib/dedupe.ts",
      "src/lib/enrichment.ts",
      "src/lib/exporter.ts",
      "src/lib/job-retry.ts",
      "src/lib/validator.ts",
    ]);
    assert.ok(!at("../../src/lib/job-retry.ts").includes("prisma."), "the importer that decides, does not run");
  });

  it("says how EXPORT obeys a mark, and keeps its own column inside the four words it documents", () => {
    // An export has no per-row loop to put a boundary inside — the crowd is one query, rendered
    // in memory, written by one `writeFile` — so its boundaries are the ones its work actually
    // has: the claim, before the bytes, after the bytes, and the finish. Four asks, and no new
    // word invented for a cancelled file: the record goes down `FAILED` with the cancel quoted,
    // which is the one status the export door's own retry already accepts.
    const body = blankComments(exporter);
    assert.match(body, /where: \{ id: jobId, status: \{ not: MARK \} \}/, "the claim carries the mark in its WHERE, like the other three");
    assert.equal((body.match(/isMarked\(await prisma\.job\.findUnique/g) ?? []).length, 3,
      "asked before the bytes, after the bytes, and inside the catch — a throw does not outrank a mark");
    assert.match(body, /where: \{ id: job\.id, status: \{ not: MARK \} \}/, "a finish writes around the mark");
    assert.match(body, /where: \{ id: jobId, status: MARK \}[\s\S]{0,120}stoppedWrite\(/,
      "and a stop writes under it, with the arithmetic of the crowd it named");
    assert.equal((body.match(/dispatchWebhookEvent\(/g) ?? []).length, 1, "one delivery site, as #41 left it");
    assert.match(body, /if \(!finish\.count\) \{\s*await putDownStopped\([\s\S]{0,90}return;\s*\}/,
      "a finish that lost the row puts both rows down and returns before the wire");
    assert.match(body, /if \(!began\.count\) \{\s*await putDownStopped\([\s\S]{0,90}return;\s*\}/,
      "and a job that never began does the same, claiming no denominator");
    assert.match(
      schema,
      /model Export \{[\s\S]*?status\s+String\s+@default\("PENDING"\)\s+\/\/ PENDING \| PROCESSING \| COMPLETED \| FAILED/,
      "a fifth value on that column is a schema decision, not a reporting one — #43 did not make one",
    );
  });

  it("says why SCRAPE is the other one left out: it still types its 100, and this instance cannot reach it", () => {
    const scraper = blankComments(at("../../src/lib/scraper.ts"));
    assert.ok(!scraper.includes("isMarked("));
    assert.match(scraper, /progress: 100/, "the fact #40's census named is still true of this file");
  });

  it("is the only hand that writes a cancelled status, besides the door that made the mark", () => {
    assert.deepEqual(
      mentioners('status: "CANCELLED"'),
      ["src/app/api/jobs/[id]/route.ts"],
      "the operator's door names the word it marks",
    );
    assert.deepEqual(mentioners("status: MARK,"), ["src/lib/job-stop.ts"], "and the obeying write is the only payload that stamps it");
    assert.deepEqual(
      mentioners("CANCELLED").filter((file) => file !== "src/lib/enums.ts"),
      ["src/app/api/jobs/[id]/route.ts", "src/lib/job-report.ts", "src/lib/job-stop.ts"],
      "no fourth file spells the status out",
    );
  });

  it("leaves a stopped row terminal for a second cancel, and open for a resume", () => {
    assert.match(detailRoute, /if \(job\.status === "COMPLETED" \|\| job\.status === "FAILED" \|\| job\.status === "CANCELLED"\)/);
    assert.match(
      blankComments(detailRoute),
      /retryAsk\(job\.status\)/,
      "the retry guard is the module's decision now, so an operator who stops a job at row 4 of 200 can restart it as a new job over the crowd the config names — the sentence #41's table had to leave in the *unchanged* column because the door still refused it",
    );
    assert.ok(
      !/Can only retry failed or completed jobs/.test(detailRoute),
      "and the answer that made a stop irreversible is gone from the door",
    );
  });

  it("keeps the mark readable on the row it stopped, in the API list's own words", () => {
    const lines = at("../../README.md").split("\n");
    const start = lines.findIndex((line) => line.startsWith("POST   /api/jobs/{id}?action=retry|cancel"));
    assert.ok(start >= 0, "the action is still in the list");
    const entry = lines.slice(start, start + 4).join("\n");
    assert.match(entry, /reads the mark before its next row/, "the list says the stop is obeyed");
    assert.match(entry, /stamps CANCELLED/);
    assert.ok(!/does not stop/.test(entry), "and no longer promises the opposite");
  });
});
