// #52, held in place: importing `src/lib/queue.ts` used to connect to Redis.
//
// `new Queue(name, {connection})` is not inert even when the client is
// `lazyConnect: true`. Measured in *this* app on the module as it was before the change
// (checked out of HEAD into a scratch file inside src/lib, imported with REDIS_URL on
// db 13): rc=124 at the 30s timeout and six keys waiting in the scratch db —
// `bull:scrape:meta` … `bull:scheduled:meta` — written by nothing but the import. Dev
// `REDIS_URL` defaults to db 0, so importing this module from a unit test wrote live dev
// state, which is why this file could not exist until the Queues moved behind getters
// (§8.26.7 for the rc=124 import variants, §8.27 for abetflow and abetagent).
//
// Laziness has a second, local failure mode in this app, and the first half of this file
// pins it: `jobRunners` used to hold `Queue` objects, which is a module-scope read of
// `queues.export`. A getter behind that table buys nothing, because the table itself is
// evaluated at import. It holds `QueueKey`s now.
//
// Two kinds of assertion, labelled as such:
//   source  — scanned from the module text, offline, always runs
//   probe   — runs only when QUEUE_PROBE_URL names a Redis db explicitly, refuses to
//             run against db 0, and checks where the connection actually landed. The
//             destination is asserted, not assumed: abetflow's copy of this file assigned
//             `process.env.REDIS_URL` inside the probe test, which runs after the
//             runtime-touch test has already imported the module, so the shared client
//             had long been built from the unset default — MONITOR caught that "scratch"
//             probe writing `bull:abetflow-runs:meta` into db 0 while db 13 stayed empty.
//             A guard that inspects the URL string instead of the connection is §8.20's
//             defect again, so the assignment is hoisted above every import and the db
//             the client reports is asserted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const queueModule = source("../../src/lib/queue.ts");
const retentionModule = source("../../src/lib/queue-retention.ts");
const sweepModule = source("../../src/lib/queue-sweep.ts");
const instrumentation = source("../../instrumentation.ts");

/**
 * Read as key/name pairs rather than one list, because the two are not the same
 * string any more: `billing` is the object key and `leadworks-billing` is the
 * Redis keyspace. A queue name is the only boundary between the products sharing
 * this Redis, so the newest queue is prefixed; the bare names stay bare because
 * renaming them would orphan keyspaces that already hold jobs — a #51 decision,
 * not an oversight. A queue built without the retention default drops out of this
 * parse, and the union comparison below is what catches that.
 */
const declared = [...queueModule.matchAll(/built\.(\w+) \?\?= new Queue\("([^"]+)", \{ connection, defaultJobOptions: JOB_RETENTION \}\)/g)]
  .map((m) => ({ key: m[1], name: m[2] }));
const KEYS = declared.map((entry) => entry.key);
const NAMES = declared.map((entry) => entry.name);

const probeUrl = process.env.QUEUE_PROBE_URL;
const probeNamesLiveDb = /\/0$/.test(probeUrl ?? "");
// Must happen before anything imports the queue module: `connection` is built from
// REDIS_URL at import time, so assigning it later changes nothing.
if (probeUrl && !probeNamesLiveDb) process.env.REDIS_URL = probeUrl;

// --- name shape ------------------------------------------------------------
// The names are bare (`scrape`, `scheduled`, …) and stay bare: rule 6 of
// shared/check-queues.sh asks for a product prefix but is scoped to the two apps renamed
// after a collision, because renaming these would orphan keyspaces that already hold
// jobs — stored state, a #51 decision, not a side effect of a shutdown fix. What is
// pinned here is constructibility and the queue↔worker pairing.
describe("every queue name is constructible and has exactly one worker", () => {
  const queueNames = [...queueModule.matchAll(/new Queue\("([^"]+)"/g)].map((m) => m[1]);
  const workerNames = [...queueModule.matchAll(/new Worker\("([^"]+)"/g)].map((m) => m[1]);

  it("declares every queue its own QueueKey type names", () => {
    // The construction list and the type have to agree. A key in the union with no
    // `built.<key>` behind it is a queue nothing can touch; one built outside the
    // union is a keyspace no type check reaches.
    const raw = /type QueueKey = ([^;]+);/.exec(queueModule);
    assert.ok(raw, "the module declares a QueueKey union this test can read");
    const union = raw[1].split("|").map((part) => part.trim().replace(/^"|"$/g, "")).sort();
    assert.deepEqual(KEYS.slice().sort(), union);
    assert.deepEqual(queueNames.slice().sort(), [...NAMES].sort());
  });

  it("contains no colon, because bullmq throws on one at construction", () => {
    for (const name of [...queueNames, ...workerNames]) {
      assert.ok(!name.includes(":"), `bullmq rejects "${name}" outright (queue-base.js:35)`);
    }
  });

  it("pairs each queue with exactly one worker of the same name", () => {
    assert.deepEqual([...workerNames].sort(), [...queueNames].sort(),
      "a queue with no worker accumulates jobs nobody drains; a worker with no queue is a poll on an empty keyspace");
  });
});

// --- import must stay inert --------------------------------------------------
describe("importing the queue module does not connect to Redis", () => {
  it("builds each Queue inside a getter, not in the object literal", () => {
    const literal = /export const queues = \{([\s\S]*?)\n\};/.exec(queueModule);
    assert.ok(literal, "queues is declared as an object literal");
    for (const key of KEYS) {
      assert.match(literal[1], new RegExp(`get ${key}\\(\\): Queue \\{`));
      assert.doesNotMatch(literal[1], new RegExp(`^\\s*${key}: new Queue\\(`, "m"));
    }
  });

  it("memoises each one, so /api/health polling does not leak a Queue per request", () => {
    // The accessor list is parsed on its own, so this is a bijection rather than a
    // restatement of the parse above: a getter that builds nothing, and a built
    // queue nobody can reach, both fail here.
    const getters = [...queueModule.matchAll(/get (\w+)\(\): Queue \{/g)].map((m) => m[1]);
    assert.deepEqual(getters.slice().sort(), KEYS.slice().sort());
    for (const { key, name } of declared) {
      assert.match(queueModule, new RegExp(`built\\.${key} \\?\\?= new Queue\\("${name}"`),
        `${key} must be built once and cached, not on every touch`);
    }
  });

  it("keeps the job-runner table on queue keys, so importing it builds nothing", () => {
    const table = /const jobRunners[\s\S]*?\n\};/.exec(queueModule);
    assert.ok(table, "the jobRunners table is where this test can read it");
    assert.doesNotMatch(table[0], /queue: queues\./,
      "a `queue: queues.export` here is a module-scope read that constructs the Queue at import, getter or not");
    assert.match(table[0], /queue: "scrape"/);
  });

  it("resolves the queue at call time, not from the table", () => {
    assert.match(queueModule, /enqueue\(queues\[runner\.queue\], runner\.name/);
  });

  it("is a lazy accessor on the imported object, at runtime", async () => {
    const { queues } = await import("../../src/lib/queue");
    for (const key of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(queues, key);
      assert.equal(typeof descriptor?.get, "function", `queues.${key} is an accessor`);
      assert.equal(descriptor?.value, undefined, `and nothing was built to import it (${key})`);
    }
  });
});

// --- every queue bounds what it keeps (#64, port of the leadgenius #61 convention) ---
// Measured locally, not inherited: `GET /api/health` here reads
// `getJobCounts("waiting", "active", "failed")` (read from src/app/api/health/route.ts) and
// never `completed`, so a completed job's hash is a Redis key with no reader — the durable
// record is the `Job` table. Nothing named retention before this, so a bare `enqueueJob`
// add and every one of the sweep's 1,440 daily jobs left a completed hash behind. The
// default sits at construction, not in `enqueue`, so both are bounded; and it is a default,
// so an add naming its own opts would still win.
describe("every queue declares retention at construction", () => {
  it("names one shared default that drops completed and caps failures", () => {
    assert.match(queueModule, /import \{ JOB_RETENTION \} from "\.\/queue-retention";/);
    assert.match(retentionModule, /export const JOB_RETENTION[^=]*= \{ removeOnComplete: true, removeOnFail: \d+ \};/);
  });

  it("hands that default to every Queue", () => {
    const bounded = [...queueModule.matchAll(/new Queue\("([^"]+)", \{ connection, defaultJobOptions: JOB_RETENTION \}\)/g)].map((m) => m[1]);
    assert.deepEqual([...bounded].sort(), [...NAMES].sort(), "a queue built without the default leaks its completed jobs");
  });

  it("constructs no queue with the bare `{ connection }` that this convention removes", () => {
    assert.doesNotMatch(queueModule, /new Queue\("[^"]+", \{ connection \}\)/);
  });

  it("keeps recent failures rather than dropping them — the failed hash is the only record", () => {
    const cap = Number(/removeOnFail: (\d+)/.exec(retentionModule)?.[1] ?? "0");
    assert.ok(cap > 0, `failed jobs are kept, capped at ${cap} — not dropped the way completed are`);
  });
});

// --- the drain ---------------------------------------------------------------
describe("shutdownWorkers closes what startWorkers started", () => {
  it("keeps every Worker, so the drain has a reference to close", () => {
    assert.match(queueModule, /const workers: Worker\[\] = \[\];/);
    const pushed = [...queueModule.matchAll(/workers\.push\(new Worker\("([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...pushed].sort(), [...NAMES].sort(),
      "startWorkers() kept none of them before this, so there was nothing to close");
  });

  it("lets in-flight Redis setup land before closing anything", () => {
    const drain = /export async function shutdownWorkers\(\) \{([\s\S]*?)\n\}/.exec(queueModule);
    assert.ok(drain, "shutdownWorkers is defined in this module");
    const body = drain[1];
    assert.ok(body.indexOf("waitUntilReady") < body.indexOf(".close()"),
      "waitUntilReady must come first: closing a Queue mid-connect is the crash at redis-connection.js:87");
    assert.ok(body.includes("catch(() => undefined)"),
      "and a waitUntilReady that never lands must be caught at creation, or abandoning it is its own unhandled rejection");
  });

  it("disconnects rather than quitting, so a never-connected client does not throw", () => {
    assert.match(queueModule, /connection\.disconnect\(\);/);
    assert.doesNotMatch(queueModule, /connection\.quit\(\)/);
  });
});

// --- who calls it ------------------------------------------------------------
describe("the drain is wired to something", () => {
  it("installs the signal handlers from instrumentation, in production only", () => {
    assert.match(
      instrumentation,
      /if \(process\.env\.NODE_ENV === "production"\) \{[\s\S]*installShutdownHandlers\(\)/,
    );
  });

  it("binds both SIGTERM and SIGINT", () => {
    const shutdown = source("../../src/lib/shutdown.ts");
    assert.match(shutdown, /\["SIGTERM", "SIGINT"\] as const/);
  });
});

// --- the producer the `scheduled` worker was missing (#53) -------------------
// Before this block the app had `new Worker("scheduled", …)` and nothing anywhere in
// `src/` that added a job to it: db 0 held `bull:scheduled:meta` with no `:id` counter
// beside it, which is bullmq's own record of a queue that has never received a job. Rule
// 10 of shared/check-queues.sh now fails on that shape; these are the local assertions on
// the fix, and the probe below re-measures the semantics the fix leans on.
describe("the scheduled worker has a producer", () => {
  const register = /export async function registerScheduledSweep\(\)[^{]*\{([\s\S]*?)\n\}/.exec(queueModule);
  const startWorkers = /export async function startWorkers\(\)[^{]*\{([\s\S]*?)\n\}/.exec(queueModule);

  it("exists, and is the only thing that supplies the queue", () => {
    assert.ok(register, "registerScheduledSweep is defined in this module");
    assert.match(register![1], /queues\.scheduled\.upsertJobScheduler\(/,
      "the sweep is registered on the queue the worker polls, not on another name");
  });

  it("keys the schedule with a fixed literal, which is what makes it idempotent", () => {
    assert.match(queueModule, /const SCHEDULED_SWEEP_KEY = "leadworks-scheduled-sweep";/);
    assert.doesNotMatch(register![1], /Date\.now|randomUUID|Math\.random|\$\{/,
      "a generated key leaves one scheduler per boot, each firing the sweep");
    assert.match(register![1], /SCHEDULED_SWEEP_KEY,/, "and the key is the first argument");
  });

  it("repeats every minute, because shouldRunNow matches the cron minute field", () => {
    assert.match(queueModule, /const SCHEDULED_SWEEP_PATTERN = "\* \* \* \* \*";/);
    assert.match(register![1], /\{ pattern: SCHEDULED_SWEEP_PATTERN \}/);
    const scheduler = source("../../src/lib/scheduler.ts");
    assert.match(scheduler, /now\.getMinutes\(\)/,
      "scheduler.ts compares stored crons against the current minute, so a coarser sweep silently drops matches");
  });

  it("hands the worker a job name, and no sweep timer is built at module scope", () => {
    assert.match(queueModule, /const SCHEDULED_SWEEP_NAME = "run-scheduled";/);
    assert.match(register![1], /\{ name: SCHEDULED_SWEEP_NAME, data: \{\} \}/);
    assert.doesNotMatch(queueModule, /setInterval|setTimeout\(\s*runScheduledJobs/,
      "a timer would fire once per process that booted; the scheduler fires once for all of them");
  });

  it("registers from startWorkers, bounded — a Redis that never answers cannot hang the boot", () => {
    assert.ok(startWorkers, "startWorkers is defined in this module");
    const body = startWorkers![1];
    // #62: the old `try { await registerScheduledSweep() } catch` was the wrong guard, because
    // against a Redis that answers nothing the call never rejects — it stays pending (bullmq
    // awaits connection readiness, ioredis retries forever at maxRetriesPerRequest:null), so no
    // catch runs and the boot hung past 12s (measured). The registration is now raced against a
    // timeout, so the boot finishes whatever the Redis does.
    assert.match(body, /await awaitWithRegistrationTimeout\(registerScheduledSweep\(\), SWEEP_REGISTER_TIMEOUT_MS\)/,
      "the registration is bounded by a timeout, not awaited bare");
    assert.doesNotMatch(body, /try \{\s*await registerScheduledSweep\(\)/,
      "the unbounded try/catch — the shape that hangs — is gone");
    assert.match(body, /=== "failed"/, "a rejected registration is reported as such");
    assert.match(body, /=== "timed-out"/, "a hung registration is reported as a timeout, distinctly");
    assert.ok(body.indexOf("workers.push(new Worker(\"scheduled\"") < body.indexOf("awaitWithRegistrationTimeout"),
      "the Workers exist before the sweep is attempted, so a hung or failed registration costs no worker");
  });

  it("is reachable from a handler that does the work", () => {
    assert.match(queueModule, /new Worker\("scheduled", async \(\) => \{\s*await runScheduledJobs\(\);/);
    const scheduler = source("../../src/lib/scheduler.ts");
    assert.match(scheduler, /export async function runScheduledJobs\(\)/,
      "the swept function is the one this app's scheduler exports");
  });

  it("declares the timeout constant and the racing helper that bounds it", () => {
    // §8.55: these three declarations live in ./queue-sweep (vendored through
    // shared/queue/sweep.ts). queue.ts keeps them reachable from its own module surface
    // via a re-export, so this app's boot path and any external caller importing from
    // ./queue still get them; the drift check fails if either side of that wiring breaks.
    assert.match(queueModule, /from "\.\/queue-sweep"/,
      "queue.ts reads the helper from ./queue-sweep, not from a local copy");
    assert.match(sweepModule, /export const SWEEP_REGISTER_TIMEOUT_MS = [\d_]+;/,
      "the ceiling is a named constant, not an inline magic number in the boot path");
    assert.match(sweepModule, /export async function awaitWithRegistrationTimeout\(/);
    // Abandonment safety, the discipline shutdownWorkers point (3) already applies to an
    // abandoned waitUntilReady: the rejection handler sits on `work` itself (two-arg then),
    // so a promise the race walked away from cannot surface as an unhandledRejection when it
    // rejects later. A `.catch` bolted onto the race instead would leave `work` unconsumed.
    assert.match(sweepModule, /work\.then\(\(\) => "registered" as const, \(\) => "failed" as const\)/);
  });
});

// --- the bounded-registration helper, driven offline (no Redis, no Worker) -------------
describe("awaitWithRegistrationTimeout names which of the three happened", () => {
  it("reports a never-settling promise as timed-out without waiting on it", async () => {
    const { awaitWithRegistrationTimeout } = await import("../../src/lib/queue");
    const t0 = Date.now();
    const outcome = await awaitWithRegistrationTimeout(new Promise<void>(() => {}), 30);
    const elapsed = Date.now() - t0;
    assert.equal(outcome, "timed-out", "the never-settling case is exactly what #62 hit, and it must resolve");
    assert.ok(elapsed < 2000, `the boot resolved rather than hanging: ${elapsed}ms`);
  });

  it("reports a settling promise as registered or failed", async () => {
    const { awaitWithRegistrationTimeout } = await import("../../src/lib/queue");
    assert.equal(await awaitWithRegistrationTimeout(Promise.resolve(), 30), "registered");
    assert.equal(await awaitWithRegistrationTimeout(Promise.reject(new Error("nope")), 30), "failed");
  });

  it("consumes a rejection that arrives after the race already timed out", async () => {
    const { awaitWithRegistrationTimeout } = await import("../../src/lib/queue");
    let rejectLater: (e: unknown) => void = () => {};
    const never = new Promise<void>((_, reject) => { rejectLater = reject; });
    const unhandled: unknown[] = [];
    const grab = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", grab);
    try {
      assert.equal(await awaitWithRegistrationTimeout(never, 20), "timed-out");
      // Redis "came back" and then errored — the abandoned registration rejects now.
      rejectLater(new Error("Connection is closed."));
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off("unhandledRejection", grab);
    }
    assert.deepEqual(unhandled, [], "an abandoned registration's late rejection must not escape unhandled");
  });
});

// --- probe: the schedule the sweep registers ------------------------------------------
// Declared before the drain probe below on purpose: `shutdownWorkers()` disconnects the
// shared client, and nothing built on it can be asked for anything afterwards.
if (probeUrl && !probeNamesLiveDb) {
  const expectedDb = Number(/\/(\d+)$/.exec(probeUrl)?.[1] ?? 0);

  describe("probe: registerScheduledSweep dedupes on its fixed key", () => {
    it("leaves one scheduler, one delayed job at the next boundary, and no residue", async () => {
      const mod = await import("../../src/lib/queue");
      const queue = mod.queues.scheduled;
      const client = await queue.waitUntilReady();
      assert.equal((client as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the probe must land on the db it was given, not on the import-time default");
      const delayedKey = `bull:${queue.name}:delayed`;

      assert.equal(await queue.getJobSchedulersCount(), 0, `db ${expectedDb} already holds a scheduler — flush it`);

      await mod.registerScheduledSweep();
      await mod.registerScheduledSweep();
      assert.equal(await queue.getJobSchedulersCount(), 1,
        "a second registration on the same key adds nothing; with a generated key this is one schedule per boot");

      const schedulers = await queue.getJobSchedulers(0, -1);
      assert.equal(schedulers.length, 1);
      assert.equal(schedulers[0]?.key, mod.SCHEDULED_SWEEP_KEY);
      assert.equal(schedulers[0]?.name, mod.SCHEDULED_SWEEP_NAME);
      assert.equal(schedulers[0]?.pattern, mod.SCHEDULED_SWEEP_PATTERN);
      assert.deepEqual(await client.zrange(delayedKey, 0, -1),
        [`repeat:${mod.SCHEDULED_SWEEP_KEY}:${schedulers[0]?.next}`],
        "the first sweep waits for the next pattern boundary, which is what `next` names");

      await queue.removeJobScheduler(mod.SCHEDULED_SWEEP_KEY);
      assert.equal(await queue.getJobSchedulersCount(), 0, "the probe cleans up after itself");
      assert.deepEqual(await client.zrange(delayedKey, 0, -1), []);
    });
  });
}

// --- probe: only against an explicitly named, non-zero db --------------------
if (probeUrl) {
  const expectedDb = Number(/\/(\d+)$/.exec(probeUrl)?.[1] ?? 0);
  describe("probe: building and draining the six queues on a scratch db", () => {
    // A skipped assertion is invisible, so a probe pointed at the live keyspace is a
    // failure first and a skip second — otherwise the run just looks one test shorter.
    it("refuses db 0, which is where dev state lives", () => {
      assert.ok(!probeNamesLiveDb, `QUEUE_PROBE_URL=${probeUrl} names the live db; name a scratch one`);
    });

    it("returns the same Queue on repeated touch, and shuts down without throwing", { skip: probeNamesLiveDb ? "refusing db 0" : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const first = mod.queues.scrape;
      assert.equal(mod.queues.scrape, first, "the getter memoises");

      // Touch all six the way /api/health does, then ask the connection where it is.
      for (const key of Object.keys(mod.queues)) void mod.queues[key as keyof typeof mod.queues];
      const client = await first.waitUntilReady();
      assert.equal((client as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the probe must land on the db it was given, not on the import-time default");

      await mod.shutdownWorkers();
      assert.notEqual(mod.queues.scrape, first, "a second build after shutdown is a fresh Queue");
    });
  });
}
