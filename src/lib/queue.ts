import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { JOB_TYPES } from "./enums";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  // Fail fast when Redis is down: without this, commands buffer forever and
  // every request that enqueues hangs instead of answering 503.
  enableOfflineQueue: false,
});

/** Thrown when a job cannot be enqueued because Redis is unreachable. */
export class QueueUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super("job queue unavailable \u2014 Redis is unreachable; the work is saved, retry shortly");
  }
}

const CONNECTION_FAILURE = /connection is closed|connection is not open|connect econnrefused|connect etimedout|stream disconnected|loading/i;

/**
 * queues.X.add that throws QueueUnavailableError (instead of hanging or
 * leaking driver errors) when Redis is down. Genuine job errors propagate
 * untouched. API routes translate QueueUnavailableError to 503.
 */
export async function enqueue<T extends object>(
  queue: Queue,
  name: string,
  data: T,
  opts?: Parameters<Queue["add"]>[2],
): Promise<Job> {
  try {
    return await queue.add(name, data, opts);
  } catch (error) {
    if (error instanceof Error && CONNECTION_FAILURE.test(error.message)) throw new QueueUnavailableError();
    throw error;
  }
}

/**
 * Built on first touch, not at import, because `new Queue()` is not inert. Handed a
 * lazy-connect client it opens that connection on the next tick and writes
 * `bull:<name>:meta` before anything calls `add()`. Measured in this app on the module as
 * it was before the change: importing it alone left the process alive at the timeout
 * (rc=124) and six `:meta` keys in the scratch db the URL named — `bull:scrape:meta`
 * through `bull:scheduled:meta`. Dev `REDIS_URL` defaults to db 0, so importing this
 * module from a unit test wrote live dev state (§8.26.7, §8.27).
 *
 * Laziness here has a second, local reason: the `jobRunners` table below used to hold a
 * `Queue` per job type, which meant a module-scope *read* of `queues.export`. Moving the
 * construction behind a getter would have bought nothing while that read stayed, because
 * the table is evaluated at import. It holds queue keys now and resolves them at call
 * time; the table's compile-time property (a `Job.type` with no runner is a type error)
 * is unchanged.
 *
 * The names are bare (`scrape`, `scheduled`, …) and stay that way. Rule 6 of
 * `shared/check-queues.sh` asks for a product prefix, and is scoped to the two apps
 * renamed after a collision, because renaming these would orphan keyspaces that already
 * hold jobs — stored state, and a #51 decision rather than a side effect of a shutdown
 * fix. Rules 4 and 5 assert the queue↔worker pairing per app where the literals appear.
 */
type QueueKey = "scrape" | "enrich" | "export" | "dedupe" | "validate" | "scheduled";

const built: Partial<Record<QueueKey, Queue>> = {};

/** Every Worker this process started, so shutdownWorkers() can actually close them. */
const workers: Worker[] = [];

/**
 * Retention applied to every job every queue here creates, as `defaultJobOptions` on each
 * construction (not in `enqueue`) so the paths that add directly are bounded too — in this
 * app that is both `enqueueJob`'s bare `queues[k].add` and `registerScheduledSweep`, which
 * names no opts. Port of the leadgenius convention (#61, §8.33) — #64.
 *
 * `removeOnComplete: true`: `GET /api/health` reads
 * `getJobCounts("waiting", "active", "failed")` and never `completed` (read from
 * `src/app/api/health/route.ts`), so a retained completed job is a Redis key with no
 * reader — the durable record of the work is the `Job` table, not the queue. The sweep
 * alone mints 1,440 completed jobs a day from the calendar and writes its result to SQLite,
 * so without this they pile up unbounded.
 * `removeOnFail: 100`: a failed job's hash is the only place its payload and stack
 * survive, so failures are kept, bounded to survive a storm without growing forever; it
 * makes the `failed` number "recent failures" rather than cumulative.
 *
 * It is a default: bullmq merges `{ ...defaultJobOptions, ...opts }` per add, so any add
 * naming its own retention still wins.
 */
import { JOB_RETENTION } from "./queue-retention";

export const queues = {
  get scrape(): Queue {
    return (built.scrape ??= new Queue("scrape", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get enrich(): Queue {
    return (built.enrich ??= new Queue("enrich", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get export(): Queue {
    return (built.export ??= new Queue("export", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get dedupe(): Queue {
    return (built.dedupe ??= new Queue("dedupe", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get validate(): Queue {
    return (built.validate ??= new Queue("validate", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get scheduled(): Queue {
    return (built.scheduled ??= new Queue("scheduled", { connection, defaultJobOptions: JOB_RETENTION }));
  },
};

/**
 * Which queue runs which `Job.type`, and the name the worker receives. Written
 * as a `Record` over the `Job.type` set so adding a type to the schema comment
 * without adding a runner here is a compile error rather than a row that sits
 * PENDING forever.
 *
 * The value is a `QueueKey`, not a `Queue`: this table is evaluated at import, and a
 * `queues.export` read here would construct the Queue — and therefore connect — at
 * import, which is the thing the getters above exist to avoid.
 */
const jobRunners: Record<(typeof JOB_TYPES)[number], { queue: QueueKey; name: string }> = {
  SCRAPE: { queue: "scrape", name: "run-scrape" },
  ENRICH: { queue: "enrich", name: "run-enrichment" },
  EXPORT: { queue: "export", name: "run-export" },
  DEDUPE: { queue: "dedupe", name: "run-dedupe" },
  VALIDATE: { queue: "validate", name: "run-validate" },
};

/**
 * Queue the worker for a `Job` row that has just been written. Throws
 * `QueueUnavailableError` when Redis is down, so the caller answers 503 rather
 * than leaving the row PENDING and reporting it as started.
 *
 * Measured before this existed: `POST /api/jobs/[id]?action=retry` and
 * `POST /api/enrichment-rules/[id]?action=run` both answered `{jobId}` for a row
 * they had only inserted, with no queue touched — the file imported `queues` and
 * never called `enqueue`. A PENDING row and a queued one read the same on
 * `GET /api/jobs`, so the caller had nothing to go on.
 */
export async function enqueueJob(type: string, jobId: string): Promise<void> {
  const runner = runnerFor(type);
  if (!runner) throw new Error(`no worker runs a job of type ${type}`);
  await enqueue(queues[runner.queue], runner.name, { jobId });
}

function runnerFor(type: string): { queue: QueueKey; name: string } | undefined {
  return (jobRunners as Record<string, { queue: QueueKey; name: string } | undefined>)[type];
}

/**
 * Whether anything is waiting to run this `Job.type`. A route checks it before
 * it copies a row, so a type with no worker never leaves a second PENDING row
 * behind: that is the state this file exists to prevent, reached from inside.
 *
 * Reachable only for a row written before the write routes checked `type`
 * against the schema's set, because Prisma reads that column as a plain string.
 */
export function hasRunner(type: string): boolean {
  return runnerFor(type) !== undefined;
}

/**
 * BullMQ's own key for the one recurring sweep this app has. Fixed rather than
 * generated, because it is what makes registering the sweep idempotent. Measured on a
 * scratch db, in one process and across two: `registerScheduledSweep()` called twice
 * leaves `getJobSchedulersCount()` at 1, and a second process upserting the same key reads
 * 1 and the same job id (`repeat:leadworks-scheduled-sweep:<next-minute>`) back again.
 * `getJobSchedulers(0, -1)` returns one row — `{ key, name: "run-scheduled", pattern,
 * next, iterationCount: 1, offset: 0 }` — and the delayed set holds exactly that id.
 * A generated key would leave one scheduler per process that ever booted this app, each of
 * them firing `runScheduledJobs()`, which creates a `Job` row per due source per sweep.
 */
export const SCHEDULED_SWEEP_KEY = "leadworks-scheduled-sweep";

/** The job name the `scheduled` worker's handler runs. */
export const SCHEDULED_SWEEP_NAME = "run-scheduled";

/**
 * Every minute. `shouldRunNow` in `scheduler.ts` compares the cron *minute* field
 * against `now.getMinutes()`, so a coarser cadence silently drops matches. What the
 * data asks for, read off a copy of `dev.db`: three active sources on `0 9 * * *` and
 * three active export profiles on `0 9 * * 1`. Nothing in this app's rows wants a
 * sub-minute schedule, and nothing matches a sweep that misses the minute. The third leg
 * of the sweep — enrichment rules with `trigger = "SCHEDULED"` — has no rows at all in
 * that copy (all three active rules are `ON_CREATE`), so it is wired but idle.
 */
export const SCHEDULED_SWEEP_PATTERN = "* * * * *";

/**
 * Register the recurring sweep, so the `scheduled` worker has a producer.
 *
 * It did not have one. `startWorkers()` pushed `new Worker("scheduled", …)` and that was
 * the whole relationship: nothing anywhere in `src/` enqueued to `queues.scheduled`, and
 * db 0 held `bull:scheduled:meta` with no `wait`, `delayed`, `active` or `completed` list
 * beside it — the keyspace of a queue that has never received a job. So `runScheduledJobs()`
 * was dead code behind a live poller, and every `0 9 * * *` source in the database was a
 * setting with no effect.
 *
 * A scheduler rather than `setInterval`, because the sweep must run once per minute for
 * the whole product, not once per process: `register()` runs in every server boot, and a
 * timer would fire from each of them. BullMQ keeps the schedule in Redis and hands out one
 * job per tick to whichever worker is listening, so N boots and 1 boot behave the same.
 *
 * Measured dependency hazard: bullmq's *ESM* build cannot be loaded at all here —
 * `dist/esm/classes/job-scheduler.js` does `import { parseExpression } from 'cron-parser'`
 * and cron-parser 4.9.0 exposes no such named ESM export, so the import throws
 * `SyntaxError` before any of this runs. `bullmq`'s package entry is `dist/cjs/index.js`,
 * which is what both `next` and `tsx --test` resolve, and the same call through it works;
 * if a future build config ever routes through `dist/esm`, this fails loudly at boot
 * rather than quietly not firing.
 *
 * Measured after the change, on a `next dev` boot aimed at db 13 and a copy of `dev.db`:
 * the log read "LeadWorks workers started" / "BullMQ workers started" with no sweep error,
 * `bull:scheduled:repeat` held one member and `bull:scheduled:completed` four within four
 * minutes of the boot, each tick leaving exactly one delayed job
 * (`repeat:leadworks-scheduled-sweep:<next-boundary>`) behind. `GET /api/health` answered
 * `ok` with all six queues. Then an active source with `schedule = "* * * * *"` was written
 * into the copy: every boundary minted one `Job` row for it, the `scrape` worker drained it
 * (`bull:scrape:completed` reached 2 by the second tick) and the job's failure was written
 * back to `Source.lastRunStatus`/`lastRunError`. The sweep is the missing link end to end —
 * a matching schedule now produces a row inside a minute, where before it produced none at
 * any hour.
 */
export async function registerScheduledSweep(): Promise<void> {
  await queues.scheduled.upsertJobScheduler(
    SCHEDULED_SWEEP_KEY,
    { pattern: SCHEDULED_SWEEP_PATTERN },
    { name: SCHEDULED_SWEEP_NAME, data: {} },
  );
}

/** The bounded-sweep registration helper is vendored through
 *  shared/queue/sweep.ts (§8.55) — see ./queue-sweep for the three declarations and
 *  the measurement that set 5s. Re-exported so `startWorkers()` and callers importing
 *  from ./queue keep their existing surface while the shape lives in one file. */
export {
  awaitWithRegistrationTimeout,
  SWEEP_REGISTER_TIMEOUT_MS,
  type RegistrationOutcome,
} from "./queue-sweep";
import { awaitWithRegistrationTimeout, SWEEP_REGISTER_TIMEOUT_MS } from "./queue-sweep";


export async function startWorkers() {
  const { runScrapeJob } = await import("./scraper");
  const { runEnrichmentJob } = await import("./enrichment");
  const { runExportJob } = await import("./exporter");
  const { runDedupeJob } = await import("./dedupe");
  const { runValidateJob } = await import("./validator");
  const { runScheduledJobs } = await import("./scheduler");

  workers.push(new Worker("scrape", async (job: Job) => {
    const { jobId } = job.data;
    await runScrapeJob(jobId);
  }, { connection, concurrency: 3 }));

  workers.push(new Worker("enrich", async (job: Job) => {
    const { jobId } = job.data;
    await runEnrichmentJob(jobId);
  }, { connection, concurrency: 5 }));

  workers.push(new Worker("export", async (job: Job) => {
    const { jobId } = job.data;
    await runExportJob(jobId);
  }, { connection, concurrency: 2 }));

  workers.push(new Worker("dedupe", async (job: Job) => {
    const { jobId } = job.data;
    await runDedupeJob(jobId);
  }, { connection, concurrency: 1 }));

  workers.push(new Worker("validate", async (job: Job) => {
    const { jobId } = job.data;
    await runValidateJob(jobId);
  }, { connection, concurrency: 2 }));

  workers.push(new Worker("scheduled", async () => {
    await runScheduledJobs();
  }, { connection, concurrency: 1 }));

  // Last, because a schedule this process could not add is not six Workers that failed to
  // start. `instrumentation.ts` answers a rejecting `startWorkers()` with "workers failed to
  // start" (read from source there) while the six Workers pushed above are constructed and
  // retrying their connection regardless — so this await must not be able to outvote them.
  //
  // Two shapes were measured here and they are NOT the same, which is why a bare try/catch
  // (the previous form) was the wrong guard. Against a Redis that answers nothing, `register-
  // ScheduledSweep()` does not reject at all: `startWorkers()` was measured STILL-PENDING past
  // 12s on :6399, because bullmq awaits the connection's readiness while ioredis reconnects
  // forever at `maxRetriesPerRequest: null` — a catch never runs, so the boot hung forever and
  // "workers started" never printed (#62). That is what the timeout now bounds. Against a
  // Redis that answers and refuses, the call DOES reject on the spot — a pattern cron-parser
  // cannot resolve throws `Error: Validation error, cannot resolve alias "non"` from
  // `upsertJobScheduler`, measured on db 13 — and that one is the `failed` branch below.
  // Distinguishing them matters: a hung boot and a rejected registration want different logs,
  // and both must let the boot finish.
  const sweep = await awaitWithRegistrationTimeout(registerScheduledSweep(), SWEEP_REGISTER_TIMEOUT_MS);
  if (sweep === "failed") {
    console.error("[LeadWorks] scheduled sweep NOT registered — no cron source will fire until a boot succeeds");
  } else if (sweep === "timed-out") {
    console.error(`[LeadWorks] scheduled sweep registration did not complete within ${SWEEP_REGISTER_TIMEOUT_MS}ms (Redis unreachable?) — boot continues; the sweep registers on the next boot that reaches Redis`);
  }

  console.log("LeadWorks workers started");
}

/**
 * Ceiling on how long shutdown waits for in-flight Redis setup to land before tearing
 * the queue down anyway. Two seconds because the only case that waits the full two is a
 * Redis that answers nothing, and that one is already measured clean without a wait.
 */
const SHUTDOWN_SETTLE_MS = 2_000;

/**
 * Graceful shutdown: settle, then Workers, then Queues, then the shared client.
 *
 * The previous body closed the queues and called `connection.quit()`, and each part of
 * that is a crash. All three were measured on the two apps that made this change first
 * (§8.27); the mechanism is the same bullmq 5.81.5 with the same shared-client shape, so
 * they are recorded here as the port's reason rather than re-derived per app.
 *
 * (1) `quit()` on a client that never connected throws `Stream isn't writeable and
 *     enableOfflineQueue options is false` — the app sets `enableOfflineQueue: false`
 *     deliberately, so a down Redis fails fast instead of buffering. `disconnect()`
 *     closes what exists and is a no-op otherwise.
 * (2) Closing the client while a Queue's connect is in flight is an *exit*, not a throw.
 *     bullmq attaches `initializing.catch(err => this.emit('error', err))` to that
 *     connect (`redis-connection.js:87`) and suppresses the rejection only inside
 *     `close()`'s `if (!this.extraOptions.shared)` branch (`redis-connection.js:429`),
 *     which is never taken when the app hands bullmq a *shared* client — as this file
 *     does, six times over. Measured rc=1 for a queue touched and closed in the same
 *     tick, rc=0 once the connection had reached `ready`.
 * (3) A Worker is not ready when the client is: its own setup issues commands after the
 *     shared connect lands, so settling only the client still died with a Worker
 *     `select` on a disconnected client (`event_handler.js:41`, measured rc=1). Hence
 *     readiness is awaited on every started object.
 * (4) `waitUntilReady()` must be caught as it is created. Abandoning one that never
 *     lands — the dead-Redis case — is itself an unhandled rejection at ioredis
 *     `Redis.js:220`, which exits 1 like the crash this function exists to avoid.
 *
 * Workers were unreachable before: `startWorkers()` kept none of them, so there was no
 * reference to close — and a live Worker polls (`bzpopmin bull:<name>:marker` is what
 * `redis-cli MONITOR` shows it doing), which is the opposite of a drain.
 *
 * Idempotent — `built` and `workers` are emptied as they close, so a second call has
 * nothing left to close and cannot double-disconnect.
 */
export async function shutdownWorkers() {
  const closingWorkers = workers.splice(0);
  const closingQueues = Object.values(built);
  for (const key of Object.keys(built) as QueueKey[]) delete built[key];

  await Promise.race([
    Promise.all([...closingQueues, ...closingWorkers].map((item) => item.waitUntilReady().catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SETTLE_MS)),
  ]);

  await Promise.all(closingWorkers.map((worker) => worker.close()));
  await Promise.all(closingQueues.map((queue) => queue.close()));
  connection.disconnect();
}