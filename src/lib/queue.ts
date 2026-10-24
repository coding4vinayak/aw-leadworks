import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
// Type-only, so it does not close a cycle at runtime: `billing-jobs` imports this
// module's queue, and the worker below needs the job shape it carries.
import type { CancellationData, TrialNudgeData } from "./billing-jobs";
import { JOB_TYPES } from "./enums";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  // Fail fast when Redis is down. It is not sufficient on its own: measured with the queue
  // off *before this process started*, `queue.add` still never settled, because BullMQ waits
  // for the connection to reach `ready` before it issues the command and the driver retries
  // forever. The deadline in `enqueue` is what answers the caller.
  enableOfflineQueue: false,
});

/** Thrown when a job cannot be enqueued because Redis is unreachable. */
export class QueueUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    // The old sentence promised "the work is saved, retry shortly", which was true of the
    // row and false about its state: it sat at `PENDING`, no door would resume it, and the
    // retry it pointed at was the 409 that says a `PENDING` job "will run". This says what
    // the caller may actually do, and `lib/queue-refusal.ts` is the write that makes it so.
    super("job queue unavailable — Redis is unreachable; the work is recorded as never queued and can be retried once the queue is back");
  }
}

const CONNECTION_FAILURE = /connection is closed|connection is not open|connect econnrefused|connect etimedout|stream disconnected|stream isn't writeable|loading/i;

/**
 * Whether a rejection from `queue.add` is the queue being unreachable.
 *
 * Both shapes are measured on a running instance, and they are not the same error:
 *
 *   · Redis dies while the process runs — `add` rejects in about a tenth of a second with
 *     ioredis's own `Error: Stream isn't writeable and enableOfflineQueue options is false`.
 *     That sentence is what the pattern had to learn; the file tested only `stream
 *     disconnected`, so the rejection reached the doors unmatched and five of them answered
 *     an unhandled `500` with a zero-byte body over a row they had already written.
 *   · the process starts while Redis is already gone — `add` never settles at all, and the
 *     `AggregateError` the driver emits (empty `message`, the two `connect ECONNREFUSED`
 *     lines on `errors[]`) only ever reaches the log, never a rejection to classify. That
 *     shape is the deadline's, not the pattern's.
 *
 * The walk into `errors[]` stays because a grouped rejection is what the driver hands back
 * wherever it does reject as an `AggregateError`, and because a child that says
 * `ECONNREFUSED` is the queue being unreachable whatever wrapped it.
 */
export function isConnectionFailure(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 4) return false;
  if (CONNECTION_FAILURE.test(error.message)) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some((child) => isConnectionFailure(child, depth + 1));
}

/**
 * Whether an error is the queue saying it cannot be reached, rather than a job failing for a
 * reason of its own. One predicate, because two vocabularies for the same fact is how a door
 * ends up reporting a connection problem as a crash. The classification itself — the single
 * `CONNECTION_FAILURE` pattern (whose driver wordings include the measured
 * `Stream isn't writeable and enableOfflineQueue options is false`) and the walk that descends
 * into a grouped rejection — stays in `isConnectionFailure`, so the vocabulary has exactly one
 * spelling. `GET /api/health` answers with no key at all, so a caller that wants to say *that*
 * to the world says "the queue is unreachable" instead and keeps the address to itself.
 */
export function isQueueConnectionFailure(error: unknown): boolean {
  return isConnectionFailure(error);
}

/**
 * queues.X.add that throws QueueUnavailableError (instead of hanging or
 * leaking driver errors) when Redis is down. Genuine job errors propagate
 * untouched. API routes translate QueueUnavailableError to 503.
 *
 * Two outage shapes were measured on a running instance, and this call answers both:
 *
 *   · Redis dies while the process runs — `add` rejects with ioredis's own sentence, which
 *     `isConnectionFailure` classifies
 *   · the process starts while Redis is already gone — `add` never settles. A door pressed at
 *     09:15:27 had written its `PENDING` row and produced no response bytes three minutes
 *     later, with the driver's `ECONNREFUSED` climbing the log all the while
 *
 * The first is a rejection to classify; the second is a wait to bound. The deadline is the
 * hand-off's own: with the queue reachable, the six doors' `add` returned in single-digit
 * milliseconds on the same instance minutes earlier, so 3 s is three orders of magnitude
 * away from any hand-off that works. A late success is possible and disclosed here: if the
 * queue comes back after the answer, the job runs and the worker writes its own status over
 * the refusal.
 */
const HANDOFF_DEADLINE_MS = 3000;

export async function enqueue<T extends object>(
  queue: Queue,
  name: string,
  data: T,
  opts?: Parameters<Queue["add"]>[2],
): Promise<Job> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      queue.add(name, data, opts),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new QueueUnavailableError()), HANDOFF_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof QueueUnavailableError) throw error;
    if (isQueueConnectionFailure(error)) throw new QueueUnavailableError();
    throw error;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
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
export type QueueKey = "scrape" | "enrich" | "export" | "dedupe" | "validate" | "scheduled" | "billing";

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
 * `getJobCounts("waiting", "active", "failed")` and never `completed` (the ask lives in
 * `src/lib/queue-snapshot.ts`, behind `src/app/api/health/route.ts`), so a retained completed job is
 * a Redis key with no
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
  /**
   * Trial-expiry warnings. Prefixed with the product where the six names above are
   * bare, and deliberately so: those are bare because renaming them would orphan
   * keyspaces that already hold jobs, which is a #51 decision. A queue created
   * today has no such history, so it starts on the safe side of rule 6 — one
   * Redis serves this whole portfolio, and a queue name is its only boundary.
   */
  get billing(): Queue {
    return (built.billing ??= new Queue("leadworks-billing", { connection, defaultJobOptions: JOB_RETENTION }));
  },
};

/**
 * The shared client's own state, as it reports it: `ready`, `connect`, `reconnecting`,
 * `wait`, `end`. A door that answers about the queues needs this beside its answer, because
 * "I could not ask" means two different things — the queue is down, or this process is
 * holding a client that gave up while the queue was down — and only the client's state tells
 * them apart.
 */
export function queueConnectionStatus(): string {
  return connection.status;
}

/**
 * Whether the shared socket is up right now. This is the fact that separates the two voices.
 *
 * It exists because a `Queue`'s client is a one-shot promise. bullmq 6.3.15's
 * `RedisConnection` sets `this.initializing = this.init()` in its constructor and its
 * `client` getter returns that same promise forever, so the `Queue` that is first touched
 * while the lazy shared client is still failing keeps rejecting with `Connection is closed.`
 * after Redis comes back — the socket is up, the instance is not. Measured end to end: a
 * `Queue` built against a port with nothing on it threw, the port came up four seconds later
 * and the shared client reached `ready`, and that instance still threw on its next twelve
 * asks and on `add()` while a `Queue` built after the recovery answered on the same
 * connection in 7 ms. On the running app the same shape cost `GET /api/health` 150 presses
 * over 12.5 minutes of saying the queue was unreachable, on a process whose `POST /api/jobs`
 * was handing off in 20-64 ms the whole time.
 *
 * So `ready` (or `connect`, which is how an ioredis Cluster reports a live socket) beside a
 * failed ask is not an outage: it is this process holding a dead client, and the client can
 * be replaced. `forgetQueue` does.
 */
export function queueConnectionLive(): boolean {
  return connection.status === "ready" || connection.status === "connect";
}

/**
 * Open the shared socket if this process has not asked for it yet, and never throw.
 *
 * The client is `lazyConnect`, so a process that has not been handed a job and has not been
 * asked about its queues sits with the socket closed and the status at `wait`. That is not an
 * outage, and a door that reads `wait` as "not live" and refuses to touch it says so forever:
 * measured on the first cut of this fix, `GET /api/health` on an instance whose Redis was up
 * answered seven `{"error":"unreachable"}` cells with `queueConnection:"wait"` on six presses
 * over 18 seconds, because nothing in the process would have opened that socket until a job
 * arrived. The old probe did not have this problem because `getJobCounts` opened the socket on
 * the way to failing.
 *
 * So the wake goes through the raw client rather than through a `Queue`, deliberately: the
 * command is issued by ioredis itself, which reports a refused connection and moves on to its
 * own retries, instead of a bullmq client capturing a failed `initializing` promise for the
 * life of the process. A press that wakes a healthy socket answers with numbers in the same
 * press; a press that wakes a dead one gets `reconnecting` back and says "unreachable" with it.
 */
export async function queueWake(): Promise<void> {
  if (connection.status !== "wait") return;
  try {
    await connection.connect();
  } catch {
    // The caller reads `queueConnectionStatus` for the fact; the reason is the driver's words
    // and carries the host and port, which this door must not echo.
  }
}

/**
 * Drop the memoized client for `key` so the next touch builds one against the connection as
 * it is now, and close the instance being dropped rather than leaving its listeners on the
 * shared client.
 *
 * Closing is safe for the neighbours and this file already relies on that: `shutdownWorkers`
 * closes every built queue and then disconnects `connection` itself, which would be a
 * redundant second act if a `Queue` closed the socket it was handed. Measured on two Queues
 * sharing one connection: `close()` on the first left the client `ready`, and the second both
 * counted and handed off after it.
 */
export function forgetQueue(key: QueueKey): void {
  const queue = built[key];
  if (!queue) return;
  delete built[key];
  queue.close().catch(() => undefined);
}

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
 * Every minute. The sweep has to be offered a tick for every minute the clock has,
 * because a cadence in the database is coarser than the sweep on purpose: `matchesSchedule`
 * in `cron-schedule.ts` decides which of those minutes mean anything, so a `0 9 * * *`
 * waits for 09:00 and a step cadence now means every fifth minute rather than nothing. What the
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
  const { runBillingJob } = await import("./billing-jobs");

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

  // One email to one owner per job, so the transport is the slow part and there
  // is nothing to gain from running two at once.
  workers.push(new Worker("leadworks-billing", async (job: Job) => {
    await runBillingJob(job as Job<TrialNudgeData | CancellationData>);
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