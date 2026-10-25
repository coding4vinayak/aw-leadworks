// #52 — a row the queue never took is not a row that finished, and the reading says so.
//
// Measured against a running instance of this app before any of this shipped, on this round's
// own base (`origin/main` at `65bd942`, built in this worktree and served on ports of its own),
// in `/tmp/opencode/r52_measure.log`:
//
//   `:3323` — booted with `REDIS_URL` on a port nothing is listening on. The door
//   `POST /api/leads/{id}?action=enrich` wrote its row first — `status: "PENDING"`,
//   `totalItems: 1` stamped by the hand that created it (`src/app/api/leads/[id]/route.ts:85`),
//   `startedAt: null` — and then the hand-off refused, so the row stayed exactly as it was
//   written. (The door itself never answered: 30 s, `curl` exit 000. That half belongs to #50,
//   whose 3 s deadline is still an open branch; this round reads the row that was left behind.)
//   `GET /api/jobs/{id}` for that row answered:
//
//     "verdict": "PENDING", "verdictNote": null,
//     "problem": "a denominator of 1 and nothing accounted for — this job finished
//                  without saying it visited any row"
//
//   — a finished-tense accusation about a job that never started. The same numbers with
//   `status` set to `RUNNING` printed the same sentence, which is the second way it is wrong:
//   a worker that has not reached its first row is *going*, and the row says so in its own
//   status column.
//
//   `:3326` — the same build, the same door, with a Redis on 6391: 200 in 133 ms with a
//   `jobId`, and three seconds later the row read `COMPLETED`, `processedItems: 1`,
//   `problem: null`, one record. So the shape the accusation fires on is not what a job that
//   ran looks like, and the reference leg proves the module does not need the sentence to
//   describe a real finish.
//
//   The list door printed neither: `GET /api/jobs?status=PENDING` returns the row's 17 columns
//   and no `report` key at all (asserted below, and left as it is — see the README).
//
// So the fix is a phase, not a new threshold: `phaseOf` reads the row's own status, and only a
// row that can no longer change is accused of having finished quietly. The false sentence had a
// job here — `problem` was the only key a caller could watch — so the truth arrives in the key
// that was empty beside it rather than leaving the report silent.
//
// Everything below runs offline: no browser, no database, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import {
  NO_DENOMINATOR,
  NOT_STARTED,
  countersProblem,
  handled,
  jobReport,
  phaseOf,
  progressOf,
  progressValue,
  verdictFor,
} from "../../src/lib/job-report";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const reportSource = at("../../src/lib/job-report.ts");
const detailRoute = at("../../src/app/api/jobs/[id]/route.ts");
const listRoute = at("../../src/app/api/jobs/route.ts");
const schema = at("../../prisma/schema.prisma");

/** The row :3323 left behind, to the column — the door's denominator and nothing else. */
const NEVER_TAKEN = { status: "PENDING", progress: 0, totalItems: 1, processedItems: 0, failedItems: 0 };
/** The same counters with the status a worker writes when it takes the row. */
const TAKEN_NOT_ARRIVED = { ...NEVER_TAKEN, status: "RUNNING" };
/** The row :3326 produced from the same door, read after the worker had run. */
const RAN = { status: "COMPLETED", progress: 100, totalItems: 1, processedItems: 1, failedItems: 0 };

describe("phaseOf — the row's own status, read as whether it can still change", () => {
  it("holds the two statuses a worker has not written its last number on", () => {
    assert.equal(phaseOf("PENDING"), "open", "created, maybe never queued — nothing has been promised and nothing kept");
    assert.equal(phaseOf("RUNNING"), "open", "a worker holds it and may still count rows into it");
  });

  it("forgives a stop the way #40 forgave it, under a name that says why", () => {
    assert.equal(phaseOf("CANCELLED"), "stopped", "the operator's mark, not a finish");
  });

  it("treats the two statuses that report what was done as final", () => {
    assert.equal(phaseOf("COMPLETED"), "closed");
    assert.equal(phaseOf("FAILED"), "closed");
  });

  it("falls back to final for a status it does not know, which is the side that promises less", () => {
    // The set is the schema comment's, and `Job.status` is a plain `String` — a row written by
    // a future migration must not be excused from its contradictions by a typo.
    assert.equal(phaseOf("ARCHIVED"), "closed", "an unknown word is not a new excuse");
    assert.equal(phaseOf(""), "closed");
  });

  it("is exactly the status column's vocabulary, partitioned", () => {
    const declared = /model Job \{[\s\S]*?status\s+String\s+@default\("PENDING"\) \/\/ (.*)/m.exec(schema);
    const words = (declared?.[1] ?? "").split("|").map((word) => word.trim());
    assert.deepEqual(words, ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"], "the schema still spells five");
    assert.deepEqual(
      words.map((word) => [word, phaseOf(word)] as const),
      [["PENDING", "open"], ["RUNNING", "open"], ["COMPLETED", "closed"], ["FAILED", "closed"], ["CANCELLED", "stopped"]],
      "every word the column holds lands in exactly one phase, and none is left out",
    );
  });
});

describe("the accusation only fires where the numbers are final", () => {
  it("does not call a row no worker took a job that finished", () => {
    // The whole round in one assertion: this is the sentence :3323's PENDING row got.
    assert.equal(countersProblem({ total: 1, processed: 0, failed: 0 }, "open"), null);
    // The sweep's shape too — `scheduler.ts` stamps the crowd it counted before it hands off,
    // so a refused hand-off leaves a hundred-row promise with nothing under it.
    assert.equal(countersProblem({ total: 100, processed: 0, failed: 0 }, "open"), null);
  });

  it("still says it, digit for digit, about a row that cannot change", () => {
    // Not softened into a vaguer word: 386 historical rows are this shape and #40's reading of
    // them is a documented answer.
    assert.equal(
      countersProblem({ total: 12, processed: 0, failed: 0 }, "closed"),
      "a denominator of 12 and nothing accounted for — this job finished without saying it visited any row",
    );
    assert.equal(countersProblem({ total: 12, processed: 0, failed: 0 }), countersProblem({ total: 12, processed: 0, failed: 0 }, "closed"),
      "and a caller that names no phase keeps the answer it had");
  });

  it("keeps the over-count a contradiction in every phase", () => {
    // Rows accounted for come from a worker that reached them. No phase explains 14 of 10,
    // not even the two that forgive the empty shape.
    for (const phase of ["open", "stopped", "closed"] as const) {
      assert.match(countersProblem({ total: 10, processed: 14, failed: 0 }, phase) ?? "", /14 row\(s\) accounted for against a denominator of 10/,
        `${phase} is not a licence to smooth an over-count away`);
    }
  });

  it("leaves a row that has begun to account for its rows alone, as it always did", () => {
    assert.equal(countersProblem({ total: 16, processed: 3, failed: 0 }, "open"), null);
    assert.equal(countersProblem({ total: 16, processed: 15, failed: 1 }, "closed"), null);
    assert.equal(countersProblem({ total: 0, processed: 0, failed: 0 }, "open"), null);
  });
});

describe("the report says what a row that has not started actually is", () => {
  it("answers the measured PENDING shape with the wait, not with a finish", () => {
    const report = jobReport(NEVER_TAKEN, 0, 0);
    assert.equal(report.verdict, "PENDING", "the stored status is still not rewritten");
    assert.equal(report.problem, null, "and the false sentence is gone");
    assert.match(report.verdictNote ?? "", /^not started: a denominator of 1 with nothing counted against it/);
    assert.match(report.verdictNote ?? "", /no worker has written a start on this row/);
    assert.match(report.verdictNote ?? "", /the wait is the fact, not a result/);
  });

  it("never puts a taken row in the other shape's mouth", () => {
    const report = jobReport(TAKEN_NOT_ARRIVED, 0, 0);
    assert.equal(report.problem, null);
    assert.match(report.verdictNote ?? "", /^in flight: a denominator of 1 with nothing counted against it yet/);
    assert.ok(!(report.verdictNote ?? "").includes("not started"), "a worker has written a start on this one");
    assert.ok(!(report.verdictNote ?? "").includes("finished"), "and neither of them finished");
  });

  it("says the absence in the present tense when no worker has stamped a denominator", () => {
    const report = jobReport({ ...NEVER_TAKEN, totalItems: 0 }, 0, 0);
    assert.equal(report.measured, false, "still not a percentage of nothing");
    assert.equal(report.percent, 0);
    assert.equal(report.reason, NOT_STARTED);
    assert.match(report.reason, /^not measured: /, "the same prefix a caller may branch on");
    assert.notEqual(report.reason, NO_DENOMINATOR, "but not a past tense about a row that has no past");
  });

  it("keeps the historical row's reason as #40 wrote it", () => {
    const report = jobReport({ ...RAN, totalItems: 0, processedItems: 16 }, 0, 0);
    assert.equal(report.reason, NO_DENOMINATOR);
    assert.match(String(report.problem), /16 row\(s\) accounted for against a denominator of 0/);
  });

  it("hands a row that ran exactly the report it handed before this round", () => {
    // The reference leg, byte for byte: :3326's COMPLETED row after three seconds.
    assert.deepEqual(jobReport(RAN, 1, 1), {
      measured: true,
      percent: 100,
      reason: null,
      verdict: "COMPLETED",
      verdictNote: null,
      problem: null,
      results: { recorded: 1, returned: 1, truncated: false },
    });
  });

  it("does not add a note to a running row that is already counting", () => {
    // main's pin of this shape stands: `RUNNING` beside 3 of 16 needs no sentence, and an
    // open row with work under it is not the shape the false sentence fired on.
    assert.deepEqual(verdictFor("RUNNING", { total: 16, processed: 3, failed: 0 }), { verdict: "RUNNING", note: null });
    assert.equal(jobReport({ ...TAKEN_NOT_ARRIVED, processedItems: 3 }, 3, 3).verdictNote, null);
  });

  it("keeps every key the door already documented", () => {
    const keys = Object.keys(jobReport(NEVER_TAKEN, 0, 0));
    assert.deepEqual(keys, ["measured", "percent", "reason", "verdict", "verdictNote", "problem", "results"],
      "the reading moves between existing keys; the shape of the answer does not change");
  });

  it("takes its phase from the caller and defaults to the one #40 assumed", () => {
    // The arity is the whole fix: a row that asks for nothing gets the old reading, and only a
    // reader holding the row's status can ask for the other one.
    assert.deepEqual(progressOf({ total: 0, processed: 0, failed: 0 }), { measured: false, percent: 0, reason: NO_DENOMINATOR });
    assert.deepEqual(progressOf({ total: 0, processed: 0, failed: 0 }, "open"), { measured: false, percent: 0, reason: NOT_STARTED });
    assert.deepEqual(progressOf({ total: 16, processed: 0, failed: 0 }, "open"), { measured: true, percent: 0, reason: null },
      "a denominator on an open row is still a denominator: 0% of 16 is honest, and `reason` stays null");
  });
});

describe("the reading changed and no write did", () => {
  it("leaves the workers' arithmetic on its default phase", () => {
    // `progressValue` is what lands in `Job.progress`. A worker's number must not become a
    // function of a status it has not written yet, so the phase is passed in exactly once in
    // all of `src/` — by the reading, from the row it was asked about.
    const phaseWord = /"(open|stopped|closed)"|phaseOf\(/;
    for (const name of ["enrichment", "validator", "exporter", "dedupe", "scraper"] as const) {
      const source = blankComments(at(`../../src/lib/${name}.ts`));
      assert.ok(!phaseWord.test(source), `${name} does not speak the reading's vocabulary at all`);
    }
    for (const name of ["enrichment", "validator", "exporter", "dedupe"] as const) {
      assert.match(blankComments(at(`../../src/lib/${name}.ts`)), /progressValue\(/, `${name} still computes its own percentage`);
    }
    const reading = blankComments(reportSource);
    const body = functionBody(reading, "jobReport")!;
    assert.equal(body.split("counters, phase").length - 1, 2,
      "the row's phase reaches exactly the two readings that can be wrong about it: the share and the contradiction");
    assert.ok(!reading.slice(0, reading.indexOf("export function jobReport")).includes("counters, phase"),
      "and neither call is made by a worker's helper, only by the door's reading");
    for (const call of reading.matchAll(/progress(?:Value)?Of?\(([^)]*)\)/g)) {
      if (call[1].includes("RowPhase")) continue; // the definition, not a call
      if (call[1].includes("counters, phase")) continue;
      assert.ok(!phaseWord.test(call[1]), `no other arithmetic call names a phase: ${call[0]}`);
    }
    assert.equal(progressValue({ total: 16, processed: 8, failed: 0 }), 50);
    assert.equal(progressValue({ total: 0, processed: 0, failed: 0 }), 0, "and the unmeasured write still lands 0");
  });

  it("passes the phase from the row's status in one place, and the door does not re-decide it", () => {
    const report = blankComments(functionBody(reportSource, "jobReport")!);
    assert.match(report, /const phase = phaseOf\(row\.status\)/, "derived once, from the column");
    assert.match(report, /progress = progressOf\(counters, phase\)/);
    assert.match(report, /countersProblem\(counters, phase\)/);
    assert.ok(!/status === "CANCELLED"/.test(report), "and the old one-word special case is gone rather than shadowed");
    const body = functionBody(detailRoute, "GET_impl")!;
    assert.match(body, /report: jobReport\(job, recorded, job\.results\.length\)/, "the door hands the row over whole");
    assert.ok(!detailRoute.includes("phaseOf") && !listRoute.includes("phaseOf"), "no door spells the judgement beside the module");
  });

  it("tells verdictFor the same story from the same column", () => {
    const verdict = blankComments(functionBody(reportSource, "verdictFor")!);
    assert.match(verdict, /phaseOf\(status\) === "open"/, "the open branch asks the phase, not a list of status words");
    assert.ok(!/PENDING|RUNNING/.test(verdict), "and the two open words are named once, in `phaseOf`, not re-spelled here");
  });

  it("holds `not measured:` and the counters helper where they were", () => {
    assert.match(NO_DENOMINATOR, /^not measured: /);
    assert.match(NOT_STARTED, /^not measured: /);
    assert.equal(handled({ total: 10, processed: 2.9, failed: -3 }), 2, "coercion did not move with the wording");
  });
});

describe("the two doors of #52's measurement, read as they still are", () => {
  it("gives the list door no report, which is this round's disclosed limit and not an accident", () => {
    const list = blankComments(functionBody(listRoute, "GET_impl")!);
    assert.ok(!list.includes("jobReport"), "the census of what was fixed: one door, not two");
    assert.match(list, /prisma\.job\.findMany/, "and it is still the row's raw columns a caller of that door reads");
  });

  it("leaves the row's own columns alone, so `problem: null` is not a rewrite of history", () => {
    // #40's rule, restated for a round that softened one of its sentences: the reading is a
    // reading. Nothing here re-writes `status`, `progress` or a counter to make it agree.
    assert.ok(!reportSource.includes("prisma."), "the module still writes nothing");
    const report = jobReport(NEVER_TAKEN, 0, 0);
    assert.equal(report.verdict, NEVER_TAKEN.status, "the stored status is echoed, not repaired");
    assert.equal(report.percent, 0, "and the stored 0 is still 0 — no row now claims a share it did not earn");
    const body = functionBody(detailRoute, "GET_impl")!;
    assert.match(body, /include: \{ source: true/, "the door still reads the row whole");
  });
});
