/** What a bounded sweep registration came back as. The three are different failures and
 *  the boot log should name which one it hit, so startWorkers must not collapse them. */
export type RegistrationOutcome = "registered" | "failed" | "timed-out";

/**
 * Ceiling on how long the boot waits for the scheduled-sweep registration to land before
 * finishing without it. Measured on scratch db 13 against a healthy Redis: the
 * registration resolves in ~0.2s and `startWorkers()` completes in 0.3–0.7s. Against a
 * Redis that answers nothing (`REDIS_URL` on :6399, nothing listening) `registerScheduled-
 * Sweep()` NEVER settles — measured `startWorkers()` still pending past 12s — because
 * bullmq awaits the shared connection's readiness, and ioredis retries forever at
 * `maxRetriesPerRequest: null`; `enableOfflineQueue: false` fails ioredis *commands*, but
 * the command is never issued because bullmq is still waiting on readiness. 5s is ~25× the
 * healthy latency, so it never false-times a working registration, and it is the whole
 * difference between a boot that hangs forever and one that reaches its "workers started"
 * line and lets `GET /api/health` answer (`queues:{"error":"redis unreachable"}`).
 */
export const SWEEP_REGISTER_TIMEOUT_MS = 5_000;

/**
 * Await `work` for at most `timeoutMs`, resolving to which of the three things happened.
 * Pure and injectable so the boot's fragility is guarded offline (the #62 defect lives in
 * how this races a never-settling promise, not inside bullmq).
 *
 * The rejection handler is attached to `work` *itself* (`then(onOk, onErr)`, not a `.catch`
 * on the race), so a promise the timeout walked away from still has a consumer: when a
 * later `Connection is closed.` rejection arrives on the abandoned registration it is
 * handled here rather than surfacing as an unhandledRejection — the same discipline
 * `shutdownWorkers` point (3) applies to an abandoned `waitUntilReady()`.
 */
export async function awaitWithRegistrationTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<RegistrationOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => "registered" as const, () => "failed" as const),
      new Promise<RegistrationOutcome>((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
