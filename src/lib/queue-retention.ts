import type { JobsOptions } from "bullmq";

/**
 * Retention applied to every job every BullMQ queue in the portfolio creates, as
 * `defaultJobOptions` on each construction (not in `enqueue`) so the paths that add
 * directly are bounded too. Port of the leadgenius convention (#61, §8.33) — #64;
 * vendored through shared/queue/retention.ts so the literal is one place and the
 * drift check fails if any app silently re-declares it locally.
 *
 * `removeOnComplete: true`: every app's `GET /api/health` reads
 * `getJobCounts("waiting", "active", "failed")` and never `completed` (read from
 * `src/app/api/health/route.ts`), so a retained completed job is a Redis key with no
 * reader — the durable record of the work is the app's database, not the queue. A
 * minute-cadence sweep alone mints ~1,440 completed jobs a day and writes its result
 * to the database; without this they pile up unbounded.
 * `removeOnFail: 100`: a failed job's hash is the only place its payload and stack
 * survive, so failures are kept, bounded to survive a storm without growing forever;
 * it makes the `failed` number "recent failures" rather than cumulative.
 *
 * It is a default: bullmq merges `{ ...defaultJobOptions, ...opts }` per add, so any
 * add naming its own retention still wins (analytics' `removeOnFail: true` and the
 * scheduled sweep's per-add `{ removeOnComplete: true }` do exactly that).
 */
export const JOB_RETENTION: JobsOptions = { removeOnComplete: true, removeOnFail: 100 };
