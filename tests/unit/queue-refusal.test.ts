// #50 — a queue that refuses is an answer, not a pending promise.
//
// Measured on a running instance of this app, with its own Redis turned off. Seven doors
// insert a `Job` row and then hand it to the queue; all seven catch
// `QueueUnavailableError` and all seven promise "the work is saved, retry shortly".
//
// | pressed with the queue down | the caller got | the row left behind |
// |---|---|---|
// | `POST /api/jobs` | `500`, **0-byte body** | `PENDING`, `error: null` |
// | `POST /api/exports` | `500`, 0-byte body | `PENDING` `Job` + `PENDING` `Export` |
// | `POST /api/leads/{id}?action=enrich` | `500`, 0-byte body | `PENDING`, `totalItems: 1`, and `report.problem`: "a denominator of 1 and nothing accounted for — this job **finished** without saying it visited any row" |
// | `POST /api/enrichment-rules/{id}?action=run` | `500`, 0-byte body | `PENDING` |
// | `POST /api/jobs/{id}?action=retry` × 7 (Redis still coming back) | `500`, 0-byte body | **seven more `PENDING` rows** |
// | the four doors again, on a process that started while Redis was already gone | **nothing** — the request never answered at all | `PENDING`, written 300 ms into a request that is still open minutes later |
// | `GET /api/health`, same moment | `200 ok: true` | `queues: { error: "redis unreachable" }` beside it |
//
// After the queue came back and 150 seconds of a healthy tick passed: **11 rows still
// `PENDING`**, `waiting` in the queue 0. `?action=retry` on each answered 409 — "a PENDING job
// has not stopped yet — the worker has not reached it, **and it will run**". The export the
// outage left behind answered 400 "Can only retry failed exports". The one door that moved a
// row was `PATCH {status: "FAILED"}`, after which `?action=retry` answered 200 with a new
// `jobId` and the job ran.
//
// Three failures, and the second round of measuring is what separated them. The classifier in
// `lib/queue.ts` tested `error.message` against six sentences, and the mid-run rejection is
// ioredis's `Error: Stream isn't writeable and enableOfflineQueue options is false` — a
// sentence none of them knew, so every door re-threw and the caller got a 500 with no body.
// A process that *starts* while the queue is already gone does not reject at all: `add` never
// settles, and the door hangs with its row written (measured: no response bytes, three
// minutes on). And the promise those doors make is worth nothing on its own either — a row the
// queue refused has to stop claiming it is about to run.
//
// So this file pins: the classifier against both error shapes that were measured, one of them
// built rather than quoted; the deadline that turns the hang into the same refusal; the write
// a refusal produces and the guard on it; that all seven doors both mark and answer; that the
// two export doors move the `Export` row too; that the four sites with no caller in front of
// them refuse without aborting the minute; and a census that no door in this app can leave a
// `PENDING` row after a refusal.
//
// Nothing here needs a database. The `enqueue` legs run the real function against a fake queue
// that throws the measured error, and against one that never answers; the rest reads source.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { QueueUnavailableError, isConnectionFailure, enqueue } from "../../src/lib/queue";
import { NEVER_QUEUED, refusalWrite } from "../../src/lib/queue-refusal";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcRoot = new URL("../../src", import.meta.url).pathname;

const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });

/** The doors that hand a row to the queue. Measured list, not a guess about intent. */
const DOORS = [
  "src/app/api/enrichment-rules/[id]/route.ts",
  "src/app/api/exports/[id]/route.ts",
  "src/app/api/exports/route.ts",
  "src/app/api/jobs/[id]/route.ts",
  "src/app/api/jobs/route.ts",
  "src/app/api/leads/[id]/route.ts",
  "src/app/api/sources/[id]/route.ts",
];

/** The rejection ioredis actually hands back when the connection dies under a running process. */
function measuredMidRunRejection(): Error {
  return new Error("Stream isn't writeable and enableOfflineQueue options is false");
}

/** The error the driver emits while it retries a connection that has never existed. */
function measuredNeverConnected(): Error {
  const first = Object.assign(new Error("connect ECONNREFUSED ::1:6387"), { code: "ECONNREFUSED" });
  const second = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6387"), { code: "ECONNREFUSED" });
  return new AggregateError([first, second]) as Error;
}

describe("the classifier sees the error the driver actually throws", () => {
  it("reads the mid-run rejection this app was measured handing back", () => {
    // The sentence the door's own catch printed on a running instance whose Redis was killed:
    // `Error: Stream isn't writeable and enableOfflineQueue options is false`, rejected about a
    // tenth of a second after the press. The pattern knew `stream disconnected` and five other
    // shapes, and this matched none of them — which is the whole of the 500 the doors answered.
    const measured = measuredMidRunRejection();
    assert.equal(isConnectionFailure(measured), true, "the rejection that reaches the doors today");
  });

  it("still reads the grouped shape the never-connected driver emits", () => {
    // A process that starts while Redis is already gone never gets a rejection from `add` (the
    // deadline below is what answers it), so this `AggregateError` is what the log fills with.
    // It stays a classified shape because a driver is allowed to reject the same way it emits:
    // `AggregateError.prototype.message` is the empty string, which is why the walk has to
    // descend at all — `CONNECTION_FAILURE.test("")` is false.
    const measured = measuredNeverConnected();
    assert.equal(measured.message, "", "the shape this pin is about, re-stated");
    assert.equal(isConnectionFailure(measured), true);
  });

  it("still reads every single-error shape it read before", () => {
    for (const message of ["Connection is closed.", "Connection is not open", "connect ECONNREFUSED 127.0.0.1:6379", "connect ETIMEDOUT", "stream disconnected", "LOADING Redis is loading the dataset"]) {
      assert.equal(isConnectionFailure(new Error(message)), true, message);
    }
  });

  it("walks a nesting, and stops somewhere", () => {
    const deep = new AggregateError([new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:6379")])]);
    assert.equal(isConnectionFailure(deep), true, "a driver is allowed to group twice");
    assert.equal(isConnectionFailure(deep, 4), false, "and the walk is bounded, so a cycle cannot spin here");
  });

  it("does not mistake a job's own failure for the queue being down", () => {
    // Genuine errors have to keep propagating, or a lead with a bad row would answer 503 and
    // tell the caller to retry a request that will fail again.
    assert.equal(isConnectionFailure(new Error("lead cmv1 has no email to enrich")), false);
    assert.equal(isConnectionFailure(new Error("Unknown enrichment provider: apollo")), false);
    assert.equal(isConnectionFailure("connect ECONNREFUSED"), false, "a thrown string is not a connection failure");
    assert.equal(isConnectionFailure(null), false);
  });

  it("turns the measured rejection into the error the doors catch", async () => {
    const fake = { add: async () => { throw measuredMidRunRejection(); } };
    await assert.rejects(
      () => enqueue(fake as never, "run-enrichment", { jobId: "job-1" }),
      (error: unknown) => error instanceof QueueUnavailableError && error.status === 503,
    );
  });

  it("turns the grouped rejection into the same answer", async () => {
    const fake = { add: async () => { throw measuredNeverConnected(); } };
    await assert.rejects(
      () => enqueue(fake as never, "run-enrichment", { jobId: "job-1" }),
      (error: unknown) => error instanceof QueueUnavailableError,
    );
  });

  it("leaves a real fault alone", async () => {
    const fake = { add: async () => { throw new Error("payload must be an object"); } };
    await assert.rejects(() => enqueue(fake as never, "run-enrichment", { jobId: "job-1" }), /payload must be an object/);
  });

  it("says what the caller can do about it", () => {
    const sentence = new QueueUnavailableError().message;
    assert.match(sentence, /Redis is unreachable/);
    assert.ok(!/the work is saved, retry shortly/.test(sentence), "the old promise is gone: it described a row that would never run");
    assert.match(sentence, /never queued/, "and the new one names the state the row is in");
    assert.match(sentence, /retr(y|ied)/, "with the door that gets it moving");
  });
});

describe("the hand-off is bounded, because a queue that never answers is not a refusal", () => {
  const queue = blankComments(at("../../src/lib/queue.ts"));

  it("names the deadline it waits", () => {
    // Measured with the process started while Redis was already gone: `add` never settled, the
    // row was written 300 ms in, and the door had produced no response bytes three minutes
    // later. With the queue reachable, the same six hand-offs answered in milliseconds — 201s
    // and 200s at 09:30:24, seven rows COMPLETED by 09:30:25 — so 3 s is orders of magnitude
    // away from any hand-off that works, and it is the only thing that answers this shape.
    assert.match(queue, /HANDOFF_DEADLINE_MS = 3000/);
    assert.match(queue, /setTimeout\(\(\) => reject\(new QueueUnavailableError\(\)\), HANDOFF_DEADLINE_MS\)/);
  });

  it("answers the refusal when the queue never does", async () => {
    const started = Date.now();
    const hanging = { add: () => new Promise(() => {}) };
    await assert.rejects(
      () => enqueue(hanging as never, "run-enrichment", { jobId: "job-1" }),
      (error: unknown) => error instanceof QueueUnavailableError && error.status === 503,
      "an unbounded wait must not survive as an unanswered request",
    );
    const waited = Date.now() - started;
    assert.ok(waited >= 2900 && waited < 5000, `the deadline is the wait, not a poll: ${waited} ms`);
  });

  it("clears the deadline when the queue answers, so a good hand-off cannot be judged later", async () => {
    const fake = { add: async () => ({ id: "queued-1" }) };
    const settled = await enqueue(fake as never, "run-enrichment", { jobId: "job-1" });
    assert.deepEqual(settled, { id: "queued-1" }, "the job the queue took, unchanged");
    assert.match(queue, /finally \{[\s\S]{0,80}clearTimeout\(deadline\)/, "the timer is cancelled on the way out of both paths");
  });
});

describe("the write a refusal makes", () => {
  it("takes the row out of the state no door will resume", () => {
    const now = new Date("2026-10-24T08:48:01.647Z");
    assert.deepEqual(refusalWrite(now), { status: "FAILED", error: NEVER_QUEUED, completedAt: now });
    assert.match(NEVER_QUEUED, /^never queued: /);
    assert.match(NEVER_QUEUED, /retry it when the queue is back/);
  });

  it("writes only a row that is still waiting", () => {
    // A worker that picked the row up in the window between the failed `add` and this
    // statement must not be answered by a refusal landing on top of it.
    const body = blankComments(functionBody(at("../../src/lib/queue-refusal.ts"), "markNeverQueued")!);
    assert.match(body, /where: \{ id: jobId, status: "PENDING" \}/);
    assert.ok(!/prisma\.job\.update\(/.test(body), "no `update`, which would write whatever it found");
  });

  it("owns the export half in the same voice", () => {
    const source = blankComments(at("../../src/lib/queue-refusal.ts"));
    const body = functionBody(source, "markExportNeverQueued")!;
    assert.match(body, /where: \{ id: exportId, status: "PENDING" \}/);
    assert.match(body, /data: refusalWrite\(now\)/, "one sentence, one shape, two tables");
  });
});

describe("every door that hands over a row refuses it in the row", () => {
  for (const file of DOORS) {
    it(`${file}: marks the row and answers 503 with its id`, () => {
      const source = at(`../../${file}`);
      const body = blankComments(functionBody(source, "POST_impl")!);
      const branch = body.slice(body.indexOf("if (error instanceof QueueUnavailableError)"));
      assert.ok(branch.length > 0, `${file} still catches the refusal`);
      const marked = branch.indexOf("markNeverQueued(");
      const answered = branch.indexOf("return NextResponse.json");
      assert.ok(marked >= 0, `${file} writes the refusal down`);
      assert.ok(marked < answered, "before it answers, so no caller is told about a row that still says `PENDING`");
      assert.match(branch, /await markNeverQueued\(/, "and awaits it — a 503 that returns before the write is a 503 about a row that still says `PENDING`");
      assert.match(branch, /jobId: (job|newJob)\.id/, "the 503 names the row to retry");
    });
  }

  it("has no door left that only answers", () => {
    const offenders = srcFiles(srcRoot)
      .filter((file) => {
        // `src/lib/queue.ts` catches the same class for the opposite reason: its branch is
        // `throw error`, the deadline's own refusal passing through the classifier untouched.
        // It writes nothing because it has written nothing — it owns no row. Named as the
        // exception rather than dropped by a looser predicate, so a door that only answers is
        // still the only other thing this file can find.
        if (file.endsWith("/queue.ts")) return false;
        const body = blankComments(readFileSync(file, "utf8"));
        return body.includes("if (error instanceof QueueUnavailableError)") && !body.includes("markNeverQueued(");
      })
      .map((file) => file.replace(srcRoot, "src"));
    assert.deepEqual(offenders, [], `a refusal is caught somewhere without being written down: ${offenders.join(", ")}`);
  });

  it("moves the export the job was minted beside, in both export doors", () => {
    for (const file of ["src/app/api/exports/route.ts", "src/app/api/exports/[id]/route.ts"]) {
      const body = blankComments(functionBody(at(`../../${file}`), "POST_impl")!);
      const branch = body.slice(body.indexOf("if (error instanceof QueueUnavailableError)"));
      assert.match(branch, /markExportNeverQueued\((id|exportRecord\.id)\)/, `${file}: the export's own retry door reads FAILED`);
    }
  });
});

describe("the sites with no caller in front of them", () => {
  const scheduler = blankComments(at("../../src/lib/scheduler.ts"));
  const enrichment = blankComments(at("../../src/lib/enrichment.ts"));

  it("hand the sweep's rows over through the refusal", () => {
    // Three sites in the minute and one in the bulk door. None of them had a catch: a queue
    // that died mid-tick took the rest of the minute with it and left the rows it had
    // already written at `PENDING`, which is the eleven-row shape this round measured.
    assert.equal((scheduler.match(/await enqueueOrMark\(/g) ?? []).length, 3, "scrape, export and enrich legs of the sweep");
    assert.equal((enrichment.match(/await enqueueOrMark\(/g) ?? []).length, 1, "and the bulk run's own hand-off");
    assert.ok(!/await enqueue\(queues\./.test(scheduler), "no bare hand-off left in the minute");
  });

  it("keeps the tick alive and says which row it lost", () => {
    const body = functionBody(at("../../src/lib/queue-refusal.ts"), "enqueueOrMark")!;
    const blanked = blankComments(body);
    assert.match(blanked, /if \(!\(error instanceof QueueUnavailableError\)\) throw error/, "a real fault still faults loudly");
    assert.match(blanked, /await markNeverQueued\(jobId\)/);
    assert.match(blanked, /console\.warn/);
    assert.match(blanked, /return false/);
    assert.ok(blanked.indexOf("markNeverQueued") < blanked.indexOf("console.warn"), "the row is truthful before the log line says it was");
  });

  it("pairs the scheduled export's refusal with its row", () => {
    const leg = scheduler.slice(scheduler.indexOf("enqueueOrMark(job.id, () => enqueue(queues.export"));
    assert.match(leg.slice(0, 700), /if \(!handed\) await markExportNeverQueued\(exportRecord\.id\)/, "and only when the queue refused");
    assert.ok(!/if \(!handed\) await markNeverQueued/.test(leg), "the job was already marked inside the helper");
  });
});

describe("the census this fix had to move", () => {
  it("counts the seven doors and no eighth", () => {
    const callers = srcFiles(srcRoot)
      .map((file) => ({ file, body: blankComments(readFileSync(file, "utf8")) }))
      // The same exception as the census above: `lib/queue.ts` catches the class it makes, and
      // owns no row to write.
      .filter((f) => !f.file.endsWith("/queue.ts"))
      .filter((f) => f.body.includes("if (error instanceof QueueUnavailableError)"))
      .map((f) => f.file.replace(srcRoot, "src"))
      .sort();
    assert.deepEqual(callers, [...DOORS].sort());
  });

  it("counts every hand-off to the queue, refusal-wrapped or not", () => {
    const hands = srcFiles(srcRoot)
      .flatMap((file) => {
        const body = blankComments(readFileSync(file, "utf8"));
        const n = (body.match(/await enqueue\(queues\.|await enqueueJob\(|await enqueueOrMark\(/g) ?? []).length;
        return n > 0 ? [`${file.replace(srcRoot, "src")}=${n}`] : [];
      })
      .sort();
    // Seven doors, one hand each; the minute's three legs; the bulk door's one. Named as
    // data so a fourth leg added later has to be written here — and guarded there — rather
    // than appearing for the first time during an outage.
    assert.deepEqual(hands, [
      "src/app/api/enrichment-rules/[id]/route.ts=1",
      "src/app/api/exports/[id]/route.ts=1",
      "src/app/api/exports/route.ts=1",
      "src/app/api/jobs/[id]/route.ts=1",
      "src/app/api/jobs/route.ts=1",
      "src/app/api/leads/[id]/route.ts=1",
      "src/app/api/sources/[id]/route.ts=1",
      "src/lib/enrichment.ts=1",
      "src/lib/scheduler.ts=3",
    ]);
  });

  it("wraps the hands with no caller waiting, and only those", () => {
    const wrapped = srcFiles(srcRoot)
      .filter((file) => blankComments(readFileSync(file, "utf8")).includes("await enqueueOrMark("))
      .map((file) => file.replace(srcRoot, "src"))
      .sort();
    assert.deepEqual(wrapped, ["src/lib/enrichment.ts", "src/lib/scheduler.ts"], "the minute's three legs and the bulk door's one");
    // Everything left that hands a row over sits in a door, where a person is on the other
    // end of the answer and the `catch` above is the guard.
    const bare = srcFiles(srcRoot)
      .filter((file) => {
        const body = blankComments(readFileSync(file, "utf8"));
        return (/await enqueue\(queues\.|await enqueueJob\(/.test(body)) && !body.includes("export async function enqueueJob");
      })
      .map((file) => file.replace(srcRoot, "src"))
      .sort();
    assert.deepEqual(bare, DOORS, "no unwrapped hand-off lives outside a door's catch");
  });
});

describe("what the app may not claim about a refused row", () => {
  it("does not call it started in the retry door's own words", () => {
    // `retryAsk` answers 409 for a `PENDING` row with "the worker has not reached it, and it
    // will run". That sentence is true of a row the queue holds and false of one it refused,
    // which is why the refusal writes `FAILED` rather than arguing with the guard.
    const retry = blankComments(at("../../src/lib/job-retry.ts"));
    assert.match(retry, /and it will run/);
    assert.ok(!/queue-refusal/.test(retry), "the guard does not learn about outages; the row arrives already truthful");
  });

  it("leaves the mark's owner alone", () => {
    // `lib/job-stop.ts` owns the write an operator's cancel produces. A refusal is a
    // different author, so it writes through its own module and never through that one.
    const stop = at("../../src/lib/job-stop.ts");
    assert.ok(!/queue-refusal|NEVER_QUEUED/.test(stop));
    const refusal = at("../../src/lib/queue-refusal.ts");
    assert.ok(!/from "\.\/job-stop"/.test(refusal), "and does not import it either");
  });
});
