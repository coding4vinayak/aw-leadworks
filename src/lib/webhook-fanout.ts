/**
 * #53 — the arithmetic of a webhook fan-out, with no fetch, no database and no clock.
 *
 * The contract this app publishes is one `lead.created` per row, so the number of
 * deliveries a 240-row import owes is not negotiable. What was negotiable was that
 * they are made one after another, and measuring that is what this module exists
 * for: on `origin/main` at `65bd942`, an import of 20 fresh rows through a
 * subscription that accepts the socket and never answers cost the door **100.19 s**
 * — the 5 s attempt budget, times the crowd — while the same 20 rows through a
 * subscription that answers in 300 ms cost **6.22 s**, and a workspace with no
 * subscription at all cost **0.17 s**. Both of the slow numbers are the row count
 * times one receiver's latency, which is a fact about a third party's endpoint
 * charged to this app's caller.
 *
 * So the two things that were wrong about the fan-out live here as arithmetic
 * rather than as I/O: `fanOut` says how many attempts may be in flight at once, and
 * `tallyDeliveries` says what the fan-out did — including which kind of failure it
 * was, because a receiver that answered 500, a receiver that never answered, and an
 * address this instance's own egress policy refused are three different sentences
 * for three different parties. Keeping them out of `webhooks.ts` is what makes the
 * pool's width, a task that throws, and the three failure arms testable without a
 * network — the same reason `job-report.ts` and `export-stop.ts` hold the reading
 * and no query.
 */

/**
 * How long one delivery may take before this process stops calling it.
 *
 * #17 named this budget as the reason a hung receiver "cannot pin the caller". It
 * is still the right cap for one attempt, and #53 measured that it is not a cap on
 * anything else: it bounds the attempt, and the request path was paying the
 * attempts in series. `WEBHOOK_FANOUT` is the other half of that sentence.
 */
export const WEBHOOK_ATTEMPT_BUDGET_MS = 5000;

/**
 * How many deliveries one subscription may have in flight at a time.
 *
 * A judgement about somebody else's endpoint, stated as a number so the waves a
 * door pays are `⌈rows / WEBHOOK_FANOUT⌉` and can be computed from what the README
 * quotes. It is deliberately small: a 240-row import posts eight at a time to its
 * subscriber rather than opening 240 sockets at it. It is deliberately **not** a
 * width across the whole fan-out — `webhooks.ts` spends it per subscription, so a
 * workspace pointing one event at nine endpoints still answers in one attempt
 * budget instead of two.
 */
export const WEBHOOK_FANOUT = 8;

/**
 * What one delivery attempt ended as.
 *
 * The three failures are different facts and are kept apart on purpose: a receiver
 * that answered 500 is reachable and said no; a receiver that never answered cannot
 * be told apart from one that died mid-request, and that is what "no answer" means;
 * an address this instance's own egress policy refuses was never attempted at all.
 * Collapsing them is what made a subscriber's outage and a typo in its URL look the
 * same from outside — the silence #17 left in `console.error`.
 */
export type DeliveryOutcome =
  | { ok: true }
  | { ok: false; kind: "refused"; reason: string }
  | { ok: false; kind: "no-answer"; reason: string }
  | { ok: false; kind: "blocked"; reason: string };

/** What one fan-out did, counted from the attempts it actually made. */
export type DeliveryTally = {
  /** Subscriptions the event was fanned out to — not subscriptions that exist. */
  subscriptions: number;
  attempted: number;
  delivered: number;
  refused: number;
  noAnswer: number;
  blocked: number;
  /** The last failure in completion order, or null when nothing failed. */
  lastError: string | null;
};

export function emptyTally(): DeliveryTally {
  return { subscriptions: 0, attempted: 0, delivered: 0, refused: 0, noAnswer: 0, blocked: 0, lastError: null };
}

/**
 * The counts a fan-out reports, from the outcomes its attempts returned.
 *
 * `attempted` is the length of the outcomes, never a number the caller supplied: a
 * tally that reports 240 deliveries when 20 were attempted is the shape of the bug
 * this family keeps finding. `lastError` is the **last** failure rather than the
 * first, because a batch whose receiver is down has one reason repeated N times and
 * the one worth printing beside the count is the most recent.
 */
export function tallyDeliveries(subscriptions: number, outcomes: readonly DeliveryOutcome[]): DeliveryTally {
  const tally = emptyTally();
  tally.subscriptions = subscriptions;
  tally.attempted = outcomes.length;
  let lastError: string | null = null;
  for (const outcome of outcomes) {
    if (outcome.ok) tally.delivered++;
    else if (outcome.kind === "refused") tally.refused++;
    else if (outcome.kind === "no-answer") tally.noAnswer++;
    else tally.blocked++;
    if (!outcome.ok) lastError = outcome.reason;
  }
  tally.lastError = lastError;
  return tally;
}

/**
 * Run `run` over every item, at most `width` of them in flight at a time.
 *
 * Items are claimed by an index that only advances, so the pool cannot lose an item
 * and cannot run one twice. `run` is expected never to throw — a delivery catches
 * its own failure and returns an outcome — but a worker holds its slot through a
 * rejection anyway, because a pool that drops a worker when a task throws silently
 * degrades toward serial under exactly the load it exists to spread. A `width` above
 * the item count costs one wave, not a promise per item, and an empty list starts no
 * work at all.
 */
export async function fanOut<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
  const workers = Math.max(1, Math.min(Math.floor(width) || 1, items.length));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const claimed = next++;
      if (claimed >= items.length) return;
      await run(items[claimed]);
    }
  };
  await Promise.allSettled(Array.from({ length: workers }, () => worker()));
}

/** The waves a fan-out of `attempts` items pays at `width` in flight. */
export function wavesFor(attempts: number, width: number = WEBHOOK_FANOUT): number {
  const perWave = Math.max(1, Math.floor(width) || 1);
  return Math.max(0, Math.ceil(Math.max(0, Math.floor(attempts)) / perWave));
}

/**
 * Which of the three arms a caught delivery failure belongs to, and what to say.
 *
 * The order is the whole rule. `assertAllowedTarget` throws with `egressCode` set,
 * so a policy refusal is recognised before anything is charged to the receiver: the
 * address was never attempted. `AbortSignal.timeout` rejects with `name:
 * "TimeoutError"` and, measured on this runtime, the message `The operation was
 * aborted due to timeout` — a budget ran out without saying which, so the number is
 * named here rather than quoted from the rejection. Everything else is a socket that
 * never got an HTTP answer, and measured on this runtime `fetch` reports those as
 * `TypeError: fetch failed` with the real sentence one level down in `cause`
 * (`connect ECONNREFUSED 127.0.0.1:8123`, code `ECONNREFUSED`), so the cause is what
 * the operator is shown instead of the wrapper.
 */
export function classifyDeliveryFailure(error: unknown): Exclude<DeliveryOutcome, { ok: true }> {
  const detail = (error ?? {}) as {
    egressCode?: string;
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  if (detail.egressCode) {
    return { ok: false, kind: "blocked", reason: detail.message || "this instance's egress policy refused the address" };
  }
  if (detail.name === "TimeoutError" || detail.name === "AbortError") {
    return { ok: false, kind: "no-answer", reason: `no answer within ${WEBHOOK_ATTEMPT_BUDGET_MS} ms` };
  }
  const socket = detail.cause?.message || detail.cause?.code;
  return { ok: false, kind: "no-answer", reason: socket || detail.message || "the delivery never completed" };
}
