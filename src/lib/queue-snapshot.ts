// The queue fact `GET /api/health` answers with — one cell per queue, an answer that always
// arrives, and never one verdict for all seven.
//
// What this replaces was measured on running instances, in three shapes the old probe could
// not tell apart:
//
// Voice one, the queue going away under a process that was healthy: the instance on :3319
// answered `{"error":"redis unreachable"}` in 16-38 ms for as long as its Redis was down, and
// went back to seven sets of numbers on the second press after the port came up — about 2 s.
// That door recovers, and this module keeps it recovering.
//
// Voice two, a process that boots while the queue is already gone: the instance on :3320
// started against a port with nothing listening on it. Its Redis came back 32 s later and
// `GET /api/health` on that same process went on answering `{"error":"redis unreachable"}`
// for the next 12.5 minutes — 150 presses in a row, 14-47 ms each — while `POST /api/jobs`
// beside it handed off in 20-64 ms and left 36 rows waiting in the queue. The door was not
// describing an outage any more; it was describing one client that this process had built
// while the outage was on, because a bullmq client is a one-shot promise (`src/lib/queue.ts`,
// `queueConnectionLive`). And because the old probe returned from its `catch` the moment the
// first queue threw, that one client erased the six sets of numbers the other queues had just
// handed back, and said "redis unreachable" about a Redis that was answering.
//
// Shape three is what the first cut of this module did about it, and it is why there is a
// deadline here: asked about a process that booted against a dead port, the per-queue version
// of the door stopped answering at all — `curl -m 12` timed out where the old probe had
// answered 200 in 29 ms. Seven sequential asks, each of them waiting on a connection that
// retries forever, is a 12-second health check at best and a silent one at worst. That is the
// same failure this app has already bounded twice, at the boot (`SWEEP_REGISTER_TIMEOUT_MS`)
// and at the hand-off, and the door that tells people the app is answering cannot be the third
// place it is left unbounded.
//
// So: one cell per queue; the socket opened through the raw client before the door calls it
// dead; nothing asked of a `Queue` while the client is not live, which is known before the
// first command and also stops the door building clients that stay broken; and a bounded ask
// with one replacement per queue per press once that client is demonstrably up again, so the
// door reports the recovery instead of waiting for the next boot.
import {
  forgetQueue,
  isQueueConnectionFailure,
  queueConnectionLive,
  queueConnectionStatus,
  queueWake,
  queues,
  type QueueKey,
} from "./queue";

/** What one queue was asked to say about itself. */
export type QueueCounts = { waiting: number; active: number; failed: number };

/** A queue's answer: its numbers, or the one thing this process can honestly say about it. */
export type QueueCell = QueueCounts | { error: string };

/** The whole report: a cell per queue key, and the shared client's own state beside them. */
export type QueueReport = { cells: Record<string, QueueCell>; connection: string };

/**
 * How long one queue gets to answer before the door stops waiting for it.
 *
 * A healthy ask costs 2-4 ms and a healthy press of seven parallel asks answers in 20-30 ms
 * (measured on :3319); a rejected ask during a running outage answers in 16-38 ms. So this
 * only ever fires for the ask that never settles, and 1 s is ~300× the healthy ask — it cannot
 * false-silence a working queue, and a press that uses it twice (the failed ask plus its
 * replacement) still answers inside ~2 s, on a door a process manager polls.
 */
export const ASK_DEADLINE_MS = 1_000;

/**
 * What the door cannot ask. Deliberately not the driver's sentence: ioredis words a refused
 * connection as `connect ECONNREFUSED 127.0.0.1:6399`, and this rides on a door that needs
 * no key. The address stays in the process and the fact comes out here.
 */
export const UNREACHABLE = "unreachable";

/**
 * A client was replaced and the queue still would not answer, which is a different sentence
 * from "unreachable" and needs to be readable as such: the replacement happened, and the
 * queue is telling us something else.
 */
export const REBUILT_BUT_SILENT = "unreachable after rebuilding this process's client for it";

const SHORTEN = 120;

/**
 * A queue's own diagnosis, for the case where it is not about the socket: a version refusal
 * or a bad script says something `unreachable` would hide. Kept short and kept verbatim, and
 * a rejection that *is* about the socket never comes through here, because the driver words
 * those with the host and port in them and this door needs no key to be answered.
 */
function ownSentence(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, SHORTEN);
}

/** The three things an ask can amount to, as one discriminated result. */
type Ask = { counts: QueueCounts } | { silent: true } | { error: unknown };

/**
 * Ask one queue, and come back inside `timeoutMs` whether or not it answers.
 *
 * A never-settling ask is not hypothetical: it is why this app has a boot deadline
 * (`queue-sweep.ts`, `SWEEP_REGISTER_TIMEOUT_MS`) and a hand-off deadline, both measured —
 * bullmq waits on the shared connection's readiness and ioredis retries forever at
 * `maxRetriesPerRequest: null`, so the command is never issued and nothing rejects. Without
 * a deadline here the per-queue shape made the door *worse* than the verdict it replaced: the
 * first press of a process that booted against a dead port went from answering 200 in 29 ms to
 * answering nothing at all (measured: `curl -m 12` timed out, code 000).
 *
 * The timer is cleared on every path, so a press that resolves does not hold the loop open
 * for the rest of the deadline — the same care the boot's race takes.
 */
async function askWithin(counts: () => Promise<QueueCounts>, timeoutMs: number): Promise<Ask> {
  const SILENT = { silent: true } as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      counts().then(
        (settled) => ({ counts: settled }),
        (error: unknown) => ({ error }),
      ),
      new Promise<Ask>((resolve) => {
        timer = setTimeout(() => resolve(SILENT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const asCell = (ask: Ask): QueueCell | undefined => ("counts" in ask ? ask.counts : undefined);

/**
 * Give `work` `timeoutMs` to settle and come back either way, reporting only whether it did.
 *
 * Used for the one ask whose answer is not the point: opening the shared socket. Whether it
 * opened is read from the connection's own state afterwards, so this only has to bound how
 * long the press waits, and to swallow both a rejection and a silence — ioredis words a
 * refused connect with the host and port in the sentence.
 */
async function settleWithin(work: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What to say about a queue whose replaced client did not answer either. If the refusal has a
 * sentence of its own that is not about the socket, that sentence is worth more than our
 * summary of it; anything else — silent, or the socket closing under it again — is the one
 * fact the operator can act on, which is that replacing the client did not help.
 */
function unrecovered(ask: Ask): { error: string } {
  if (!("error" in ask)) return { error: REBUILT_BUT_SILENT };
  return { error: isQueueConnectionFailure(ask.error) ? REBUILT_BUT_SILENT : ownSentence(ask.error) };
}

/** Everything a snapshot needs, as arguments, so the shape can be driven without a Redis. */
export type SnapshotWiring = {
  keys: QueueKey[];
  counts: (key: QueueKey) => Promise<QueueCounts>;
  connectionLive: () => boolean;
  connectionStatus: () => string;
  wake: () => Promise<void>;
  forget: (key: QueueKey) => void;
  timeoutMs?: number;
};

const liveWiring: SnapshotWiring = {
  keys: Object.keys(queues) as QueueKey[],
  counts: async (key) => {
    const counted = await queues[key].getJobCounts("waiting", "active", "failed");
    return { waiting: counted.waiting, active: counted.active, failed: counted.failed };
  },
  connectionLive: queueConnectionLive,
  connectionStatus: queueConnectionStatus,
  wake: queueWake,
  forget: forgetQueue,
};

/**
 * One cell per queue, and an answer that arrives inside about two deadlines whether or not
 * the queues are cooperative.
 *
 * Three rules, all of them the measured gap between what the old probe said and what is true:
 *
 *  1. A queue that answers keeps its numbers whatever the others did. The old probe returned
 *     from its `catch` at the first throw, so one client that had given up erased six sets of
 *     numbers and reported a Redis that was answering as unreachable.
 *  2. When the shared client is not live, the socket is opened before anything is concluded,
 *     and then nothing is asked. The client is lazy, so `wait` means only that this process has
 *     not needed it yet: the first cut of this module read that as an outage and answered seven
 *     `{"error":"unreachable"}` cells on a healthy instance, on every press, until a job arrived
 *     to open the socket (`queueWake`). Beyond that the state is known before the first command,
 *     every ask would either reject in ~20 ms or never settle, and issuing them anyway builds
 *     clients that stay broken for the life of the process — which is the defect. The press
 *     costs the connection's state and seven honest cells.
 *  3. When the shared client *is* live and one queue will not answer anyway, that queue's
 *     client was built while the outage was on. It is dropped and asked again in the same
 *     press, so the door reports the recovery rather than waiting for the next boot. One
 *     replacement per queue per press, and never during a real outage — so there is no
 *     rebuild storm to leak.
 *
 * Queues are asked concurrently because they share one socket and a press must answer: seven
 * sequential asks with a 1 s deadline would be a 7 s health check on a box that is mostly
 * fine. Measured, a healthy press of seven parallel asks answers in 20-30 ms, and the whole
 * report is ordered by the module's own key list so the body's shape does not depend on which
 * queue won first.
 */
export async function queueSnapshot(wiring: SnapshotWiring = liveWiring): Promise<QueueReport> {
  const timeoutMs = wiring.timeoutMs ?? ASK_DEADLINE_MS;
  const cells: Record<string, QueueCell> = {};
  if (!wiring.connectionLive()) {
    await settleWithin(() => wiring.wake(), timeoutMs);
    if (!wiring.connectionLive()) {
      for (const key of wiring.keys) cells[key] = { error: UNREACHABLE };
      return { cells, connection: wiring.connectionStatus() };
    }
  }

  const asked = await Promise.all(
    wiring.keys.map(async (key) => {
      const first = await askWithin(() => wiring.counts(key), timeoutMs);
      const answered = asCell(first);
      if (answered) return [key, answered] as const;
      wiring.forget(key);
      const second = await askWithin(() => wiring.counts(key), timeoutMs);
      return [key, asCell(second) ?? unrecovered(second)] as const;
    }),
  );
  for (const [key, cell] of asked) cells[key] = cell;
  return { cells, connection: wiring.connectionStatus() };
}
