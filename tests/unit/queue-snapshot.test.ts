// #51 — the health door's queue probe, told one queue at a time, and always answered.
//
// Measured against running instances before any of this shipped, in three shapes the old
// probe could not tell apart:
//
//   `:3319` — booted with its Redis up, then lost it. `GET /api/health` answered 200 in
//   16-38 ms with `queues: {"error":"redis unreachable"}` for as long as the port was down,
//   and went back to seven sets of numbers on the second press (~2 s) after the port came up.
//   The probe recovers. Nothing here breaks that.
//
//   `:3320` — booted against a port with nothing listening on it. Redis came back 32 s later
//   and the same door on the same process answered `queues: {"error":"redis unreachable"}` on
//   every one of the next 150 presses over 12.5 minutes (14-47 ms each), while `POST /api/jobs`
//   beside it answered in 20-64 ms and left 36 rows waiting in the queue it was calling
//   unreachable. The probe did not recover, and it was not describing an outage: one of the
//   seven clients had been built while the outage was on, and a bullmq client is a one-shot
//   promise — `src/lib/queue.ts`, `queueConnectionLive`, measured end to end in
//   `/tmp/opencode/r51_heal.out`: the poisoned instance threw on its next twelve asks and on
//   `add()` with the shared client `ready`, while a `Queue` built on that same connection after
//   the recovery answered in 7 ms and handed off. And the reporting damage was wider than the
//   stale word: the old probe returned from its `catch` the moment the first queue threw, so
//   that one client erased the six sets of numbers the other queues had just handed back.
//
//   `:3321` — the first cut of this module, pressed on a process that booted blind to its
//   queue. It answered nothing: `curl -m 12` came back code 000 where the old door had
//   answered 200 in 29 ms. Seven asks, each waiting on a connection that retries forever, is
//   the same unbounded wait this app has already bounded twice — at the boot
//   (`SWEEP_REGISTER_TIMEOUT_MS`) and at the hand-off. So the press is bounded, and the door
//   answers before anything else does.
//
//   `:3319` again — the second cut, pressed on an instance whose Redis was up the whole time.
//   The shared client is `lazyConnect` and nothing in that process had touched a queue yet, so
//   its status was `wait`, the new short-circuit read `wait` as an outage, and six presses over
//   18 seconds answered seven `{"error":"unreachable"}` cells with `queueConnection:"wait"`.
//   A door that refuses to open the socket it is reporting on never learns better, so the press
//   opens it first — through the raw client, which is the one way to do it that cannot leave a
//   poisoned `Queue` memoized behind.
//
// Everything below runs offline: `queueSnapshot` takes its probes as arguments, so all three
// shapes are driven as arguments rather than as a Redis, and the wiring claims are read off the
// source — which is the only place the "no queue is built at import" property this app already
// pins can be checked from.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import {
  ASK_DEADLINE_MS,
  queueSnapshot,
  REBUILT_BUT_SILENT,
  UNREACHABLE,
  type QueueCounts,
  type SnapshotWiring,
} from "../../src/lib/queue-snapshot";
import { isQueueConnectionFailure, queues } from "../../src/lib/queue";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const snapshotSource = at("../../src/lib/queue-snapshot.ts");
const queueSource = at("../../src/lib/queue.ts");
const healthSource = at("../../src/app/api/health/route.ts");

const COUNTS = (waiting: number): QueueCounts => ({ waiting, active: 0, failed: 0 });
const CLOSED = () => {
  throw new Error("Connection is closed.");
};
const REFUSED = () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:6399");
};
/** The ask that never settles — the shape that made :3321 stop answering. */
const SILENT = () => new Promise<QueueCounts>(() => undefined);

/**
 * A wiring over named fake queues. `refusals` maps a key to what its asks do, in attempt
 * order: a key listing one refusal fails its first ask and answers after that, which is what a
 * replaced client does. A key with no entry answers `COUNTS(index)`, so every number in a
 * report is traceable to the queue that vended it. `forgotten` and `asked` are the receipts.
 */
function fakes(
  keys: string[],
  refusals: Record<string, Array<() => QueueCounts | Promise<QueueCounts>>> = {},
  options: {
    live?: boolean;
    status?: string;
    timeoutMs?: number;
    wake?: () => Promise<void>;
  } = {},
): SnapshotWiring & { forgotten: string[]; asked: string[] } {
  const forgotten: string[] = [];
  const asked: string[] = [];
  const tries: Record<string, number> = {};
  return {
    keys: keys as SnapshotWiring["keys"],
    forgotten,
    asked,
    timeoutMs: options.timeoutMs ?? 80,
    counts: async (key) => {
      asked.push(key);
      const queue = refusals[key] ?? [];
      const attempt = tries[key] ?? 0;
      tries[key] = attempt + 1;
      const refusal = queue[attempt];
      if (refusal) return refusal() as QueueCounts;
      return COUNTS(keys.indexOf(key));
    },
    connectionLive: () => options.live ?? true,
    connectionStatus: () => options.status ?? "ready",
    wake: options.wake ?? (async () => undefined),
    forget: (key) => {
      forgotten.push(key);
    },
  };
}

describe("isQueueConnectionFailure — the one vocabulary for the two voices", () => {
  it("names the outage wordings this branch's driver throws", () => {
    assert.ok(isQueueConnectionFailure(new Error("Connection is closed.")), "a client with no socket — the wording :3320 answered with for 150 presses");
    assert.ok(isQueueConnectionFailure(new Error("connect ECONNREFUSED 127.0.0.1:6399")), "a port nothing is on");
    assert.ok(isQueueConnectionFailure(new Error("Connection is not open.")), "ioredis' other closed-socket sentence");
  });

  // Measured on this branch, against :3319 with its Redis killed under it: `POST /api/jobs`
  // answered 500 in 39 ms with an empty body, because the driver's rejection there is
  // `Stream isn't writeable and enableOfflineQueue options is false` and `main` does not class
  // that as a connection failure, so the route's 503 translation never ran. That wording
  // belongs to PR #77 (`fix(#50)`, commit `c0209ab`), which adds it to `CONNECTION_FAILURE`
  // from the other side of the same line; claiming it here would re-fix another round's defect
  // and buy a merge conflict. What this file does pin is that once #77 lands there is exactly
  // one place left to spell the pattern.
  it("leaves the third driver wording to the branch that already owns it", () => {
    assert.ok(!isQueueConnectionFailure(new Error("Stream isn't writeable and enableOfflineQueue options is false")),
      "not claimed by this branch, and said so rather than quietly matched");
  });

  it("does not call a job's own failure a connection failure", () => {
    assert.ok(!isQueueConnectionFailure(new Error("lead 42 has no enrich provider")), "a real job error stays a job error");
    assert.ok(!isQueueConnectionFailure("Connection is closed."), "and a thrown non-Error is not claimed as one either");
  });

  it("is the predicate `enqueue` uses, not a second copy of the pattern", () => {
    const start = queueSource.indexOf("export async function enqueue<");
    const body = queueSource.slice(start, queueSource.indexOf("\n}", start));
    assert.ok(start > -1 && body.length > 0, "the hand-off helper is readable");
    assert.match(body, /isQueueConnectionFailure\(error\)/, "the hand-off asks this predicate");
    assert.ok(!body.includes("CONNECTION_FAILURE.test"), "and does not re-test the regex beside it");
  });
});

describe("queueSnapshot — one cell per queue", () => {
  it("keeps the numbers a queue handed back when a different queue never gives one up", () => {
    // The whole round in one assertion: on :3320 six queues answered and the report an
    // operator got was `{"error":"redis unreachable"}`.
    const wiring = fakes(["scrape", "scheduled", "enrich"], { scheduled: [CLOSED, CLOSED] });
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(report.cells.scrape, COUNTS(0), "the queue that answered keeps its numbers");
      assert.deepEqual(report.cells.enrich, COUNTS(2), "and so does the next one after the failure");
      assert.deepEqual(report.cells.scheduled, { error: REBUILT_BUT_SILENT }, "only the queue that refused says it refused");
      assert.equal(Object.keys(report.cells).length, 3, "one cell per queue, not a verdict for the lot");
      assert.equal(report.connection, "ready", "and the shared client's own state rides beside them");
      assert.deepEqual(wiring.forgotten, ["scheduled"], "and it was replaced, which the old door could only guess at");
    });
  });

  it("never claims failure about a queue that answered", () => {
    const wiring = fakes(["scrape", "scheduled", "export"], { scheduled: [CLOSED, CLOSED] });
    return queueSnapshot(wiring).then((report) => {
      for (const [key, cell] of Object.entries(report.cells)) {
        if (key === "scheduled") continue;
        assert.ok(!("error" in cell), `${key} vended numbers and is not described as a failure`);
      }
    });
  });

  it("keeps a driver's address out of an answer the door gives without a key", () => {
    const wiring = fakes(["scrape", "scheduled"], { scrape: [REFUSED, REFUSED], scheduled: [REFUSED, REFUSED] });
    return queueSnapshot(wiring).then((report) => {
      const body = JSON.stringify(report);
      assert.deepEqual(report.cells.scrape, { error: REBUILT_BUT_SILENT }, "the fact, in the app's own words");
      assert.ok(!body.includes("127.0.0.1") && !body.includes("6399"), `no host or port in the body: ${body}`);
    });
  });

  it("keeps a sentence that is not about the connection as its own sentence", () => {
    const version = () => {
      throw new Error("Redis version needs to be greater or equal than 5.0.0");
    };
    const wiring = fakes(["scrape"], { scrape: [version, version] });
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(report.cells.scrape, { error: "Redis version needs to be greater or equal than 5.0.0" },
        "a diagnosis that is not about the socket is not filed under a summary of it");
    });
  });
});

describe("queueSnapshot — the shapes are driven differently", () => {
  it("asks nothing while the shared client is down, because an ask there cannot help", () => {
    // The socket's state is known before the first command: during an outage every ask would
    // either reject in ~20 ms or never settle, and issuing it anyway builds clients that stay
    // broken for the life of the process — the defect this file is about.
    const wiring = fakes(["scrape", "enrich", "scheduled"], {}, { live: false, status: "reconnecting" });
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(wiring.asked, [], "not one command issued");
      assert.deepEqual(wiring.forgotten, [], "and nothing replaced — an outage is not a broken client");
      for (const key of ["scrape", "enrich", "scheduled"]) {
        assert.deepEqual(report.cells[key], { error: UNREACHABLE }, `${key} says what the door knows`);
      }
      assert.equal(report.connection, "reconnecting", "and says which of the two voices it is");
    });
  });

  it("opens a socket this process has never asked for, instead of reporting it dead", () => {
    // The second cut's own defect, measured on :3319 with its Redis up: the shared client is
    // `lazyConnect`, so an instance that had not been handed a job sat at status `wait`, the
    // door read `wait` as "not live" and answered seven `{"error":"unreachable"}` cells on six
    // presses over 18 seconds. The verdict was not an outage, it was an unopened socket, and
    // only the press itself can find out which.
    const wiring = fakes(["scrape", "enrich", "scheduled"], {}, { live: false, status: "wait" });
    wiring.wake = async () => {
      wiring.connectionLive = () => true;
      wiring.connectionStatus = () => "ready";
    };
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(wiring.asked, ["scrape", "enrich", "scheduled"], "the queues are asked once the socket is known");
      assert.deepEqual(report.cells.scrape, COUNTS(0), "and a healthy instance is reported healthy on its first press");
      assert.equal(report.connection, "ready", "the state the wake arrived at is the state reported");
      assert.deepEqual(wiring.forgotten, [], "nothing was replaced, because nothing was broken");
    });
  });

  it("still answers when the socket it is trying to open never gives one", () => {
    // `connect()` on a port that black-holes the SYN waits on ioredis' own connect timeout, so
    // the wake is bounded like the asks are. Measured on :3321, which booted against a dead
    // port and whose press must not become the 12-second silence the first cut produced.
    const timeoutMs = 60;
    const wiring = fakes(["scrape", "scheduled"], {}, { live: false, status: "wait", timeoutMs });
    wiring.wake = () => new Promise<void>(() => undefined);
    const started = Date.now();
    return queueSnapshot(wiring).then((report) => {
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3 * timeoutMs, `the press came back in ${elapsed}ms, on one deadline`);
      assert.deepEqual(wiring.asked, [], "and it did not ask a queue while the socket was still unknown");
      assert.deepEqual(report.cells.scrape, { error: UNREACHABLE }, "the door answers, with what it knows");
    });
  });

  it("replaces the client that failed while the connection was up, and reads its numbers in the same press", () => {
    const wiring = fakes(["scrape", "scheduled"], { scheduled: [CLOSED] });
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(wiring.forgotten, ["scheduled"], "the latched client is dropped, and only that one");
      assert.deepEqual(report.cells.scheduled, COUNTS(1), "the rebuilt client answers on the press that rebuilt it");
      assert.deepEqual(wiring.asked, ["scrape", "scheduled", "scheduled"], "asked again once, not retried in a loop");
    });
  });

  it("answers a queue that will never settle, instead of becoming the door that hangs", () => {
    const timeoutMs = 60;
    const wiring = fakes(["scrape", "scheduled"], { scheduled: [SILENT, SILENT] }, { timeoutMs });
    const started = Date.now();
    return queueSnapshot(wiring).then((report) => {
      const elapsed = Date.now() - started;
      assert.deepEqual(report.cells.scheduled, { error: REBUILT_BUT_SILENT }, "silence is reported, not waited on");
      assert.deepEqual(report.cells.scrape, COUNTS(0), "and the queue that answers is not held up by the one that does not");
      assert.ok(elapsed < 6 * timeoutMs, `the press came back in ${elapsed}ms, under six deadlines (measured: :3321 answered nothing in 12s)`);
      assert.ok(elapsed >= 2 * timeoutMs, `and it did spend the two bounded asks it waited for (${elapsed}ms)`);
    });
  });

  it("does not let a throwing probe take the door down", () => {
    // The door answers 503 only for a database it cannot reach; a queue probe that throws
    // anything at all must still come back as a cell.
    const wiring: SnapshotWiring = {
      keys: ["scrape", "scheduled"] as SnapshotWiring["keys"],
      counts: async (key) => {
        if (key === "scrape") throw "a bare string, not an Error";
        throw new TypeError("something the probe did not expect");
      },
      connectionLive: () => true,
      connectionStatus: () => "ready",
      wake: async () => undefined,
      forget: () => undefined,
      timeoutMs: 40,
    };
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(report.cells.scrape, { error: "a bare string, not an Error" }, "a non-Error still becomes a cell");
      assert.deepEqual(report.cells.scheduled, { error: "something the probe did not expect" });
      assert.equal(report.connection, "ready");
    });
  });

  it("gives every queue the module can build its own cell", () => {
    const keys = ["scrape", "enrich", "export", "dedupe", "validate", "scheduled", "billing"];
    const wiring = fakes(keys, Object.fromEntries(keys.map((key) => [key, [CLOSED, CLOSED]])));
    return queueSnapshot(wiring).then((report) => {
      assert.deepEqual(Object.keys(report.cells), keys, "one per queue, in the module's own order");
      assert.equal(wiring.forgotten.length, keys.length, "each of them replaced, once");
    });
  });
});

describe("the door and the module are wired, not re-spelled", () => {
  it("reports every queue the module can build, without the door naming any of them", () => {
    // The census: a queue added to `src/lib/queue.ts` appears at the door with no edit there.
    // `Object.keys` reads the getter names without invoking them, which is what keeps the
    // importing-does-not-connect property `tests/unit/queue.test.ts` holds.
    const declared = [...queueSource.matchAll(/built\.(\w+) \?\?= new Queue\("/g)].map((m) => m[1]);
    assert.deepEqual(Object.keys(queues).sort(), declared.sort(), "the door's queue list is the module's, in both directions");
    assert.match(snapshotSource, /keys: Object\.keys\(queues\)/, "and the wiring derives it rather than naming it");
  });

  it("builds no queue outside the probe that is going to ask it", () => {
    // `tests/unit/queue.test.ts` holds the property that importing this app's queue module
    // connects to nothing; a module-scope `queues.export` read here would put that read back
    // at import time. So: no dotted read of the memo anywhere in the file, and the one
    // indexed read lives inside the `counts` probe.
    const code = blankComments(snapshotSource);
    assert.ok(!/\bqueues\.[a-zA-Z]+/.test(code), "no `queues.scrape`-style read, at import or anywhere else");
    const probe = code.indexOf("counts: async (key) =>");
    const read = code.indexOf("queues[key]");
    assert.ok(probe > -1 && read > probe, "the memo is touched only inside the probe that asks it");
    assert.equal(code.split("queues[key]").length - 1, 1, "and exactly once");
    assert.match(code, /keys: Object\.keys\(queues\)/, "and the key list is read as names, which builds nothing");
  });

  it("answers the queue from the snapshot module, not from a second copy in the route", () => {
    const health = blankComments(healthSource);
    const snapshotCode = blankComments(snapshotSource);
    const queueCode = blankComments(queueSource);
    assert.ok(health.includes('from "@/lib/queue-snapshot"'), "the door imports the judgement");
    assert.ok(!health.includes('from "@/lib/queue"'), "and does not reach past it to the queues themselves");
    assert.match(health, /queues: report\.cells/, "one cell per queue in the body");
    assert.match(health, /queueConnection: report\.connection/, "and the shared client's state beside them");
    for (const [name, code] of [["the door", health], ["the probe", snapshotCode], ["the module", queueCode]] as const) {
      assert.ok(!code.includes("redis unreachable"), `${name} no longer spells the all-or-nothing verdict in code`);
    }
    assert.ok(!/catch\s*\{\s*return \{ error:/.test(health), "and no door-level catch vends a verdict for the whole queue any more");
  });

  it("bounds the press, because an unbounded health door is the defect this round found twice", () => {
    const code = blankComments(snapshotSource);
    assert.match(code, /const timeoutMs = wiring\.timeoutMs \?\? ASK_DEADLINE_MS/, "one deadline, defaulted in the module");
    assert.ok(ASK_DEADLINE_MS >= 500 && ASK_DEADLINE_MS <= 5_000, `the deadline is a real wait, not a false silence: ${ASK_DEADLINE_MS}ms against a 2-4ms healthy ask`);
    const ask = functionBody(code, "askWithin")!;
    assert.match(ask, /Promise\.race/, "the ask is raced, not awaited");
    assert.match(ask, /clearTimeout\(timer\)/, "and a press that resolves does not hold the loop open for the rest of the deadline");
  });

  it("still 503s for the one fact that has always decided the status", () => {
    const body = blankComments(healthSource);
    const query = body.indexOf("prisma.$queryRaw");
    const snapshot = body.indexOf("await queueSnapshot()");
    const fiveOhThree = body.indexOf("{ status: 503 }");
    assert.ok(query > -1 && snapshot > query, "the queue is asked after the database, as it always was");
    assert.ok(fiveOhThree > snapshot, "and only the database catch returns 503");
    assert.match(body, /db: "down"/, "the down answer is still the database's answer");
  });

  it("opens the socket through the raw client, never through a Queue", () => {
    // Going through `queues[key]` is what poisons a process: the bullmq client captures its
    // one-shot `initializing` promise on the way to opening the socket, so a wake issued there
    // while the port is dead leaves a dead client memoized for the rest of the process's life.
    const wake = blankComments(functionBody(queueSource, "queueWake")!);
    assert.match(wake, /connection\.status !== "wait"/, "it is a no-op for a client that has already been opened");
    assert.match(wake, /await connection\.connect\(\)/, "and the raw ioredis client is what opens it");
    assert.ok(!/queues[.[]/.test(wake), "it never touches a Queue, which is the difference between a wake and a poisoning");
    assert.ok(!/throw/.test(wake), "and it swallows, because the caller reads the status rather than the reason");

    const code = blankComments(snapshotSource);
    const wakeCall = code.indexOf("wiring.wake()");
    const verdict = code.indexOf(`{ error: UNREACHABLE }`);
    assert.ok(wakeCall > -1 && verdict > wakeCall, "the door opens the socket before it calls it dead");
    assert.match(code, /if \(!wiring\.connectionLive\(\)\)/, "and checks the state the wake arrived at, not what it hoped for");
  });

  it("drops a client without touching the socket every other queue shares", () => {
    const forget = blankComments(functionBody(queueSource, "forgetQueue")!);
    assert.match(forget, /delete built\[key\]/, "the memo is dropped, so the next touch builds a fresh client");
    assert.match(forget, /queue\.close\(\)\.catch/, "the dropped instance is closed, not left holding listeners");
    assert.ok(!/connection\.(quit|disconnect)/.test(forget), "and it never quits the shared connection — that is shutdownWorkers' job");
    const shutdown = blankComments(functionBody(queueSource, "shutdownWorkers")!);
    assert.match(shutdown, /connection\.disconnect\(\)/, "which is why the shutdown path disconnects it itself, after closing the queues");
  });

  it("defines the live socket as the two states ioredis uses for it", () => {
    const live = blankComments(functionBody(queueSource, "queueConnectionLive")!);
    assert.match(live, /connection\.status === "ready"/, "a plain client says ready");
    assert.match(live, /connection\.status === "connect"/, "and a Cluster says connect for the same live socket");
    assert.ok(!/"wait"|"reconnecting"|"end"/.test(live), "nothing else counts as live, so an outage never triggers a rebuild");
  });
});
