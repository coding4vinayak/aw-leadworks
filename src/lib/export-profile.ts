import { matchesSchedule, scheduleProblem } from "./cron-schedule";

/**
 * What the minute does with one export profile, in the customer's own terms.
 *
 * `ExportProfile` is the table the sweep reads (`scheduler.ts`'s profile leg) and the one
 * `GET /api/exports?profileId=` filters by, and until this round no door could read it:
 * measured on `origin/main` (`65bd942`, `:3391` over `leadworks_r59`), `GET
 * /api/export-profiles` and `GET /api/export-profiles/{id}` were both `404` and the answer
 * was the Next.js HTML page, `POST`/`PATCH`/`DELETE` on those paths the same, the served
 * contract had **zero paths mentioning a profile** and `llms-full.txt` had zero lines
 * matching `export-profile`, while `prisma/seed.ts` was the only writer in the repository
 * (`prisma.exportProfile.create` appears nowhere else in `src/`).
 *
 * The consequence is not only an undiscoverable id. The sweep's own skip is invisible: over
 * nine sweep minutes this runtime printed
 *
 *   Export profile xp_r59_broken is active and scheduled, but no minute matches it — day of week "9" holds 9, outside 0-7
 *
 * eight times in its log, created **no** export for that row, and created nine each for the
 * two profiles whose cadence matches every minute (`xp_r59_minute` for this workspace,
 * `xp_r59_foreign` for the tenant next door) — while the row itself still reads
 * `isActive = true`, `schedule = "0 9 * * 9"`. A weekly drop that will never happen and a
 * weekly drop that happens are the same record to every door that exists, and the difference
 * is visible only to whoever can read the server's stdout.
 *
 * So the verdict lives here, computed by the same `cron-schedule.ts` grammar the sweep
 * matches against and the write doors refuse with, and `scheduler.ts` builds its warning out
 * of it rather than beside it. That is the whole point of the shape: the door and the minute
 * cannot disagree, because they read one function.
 */
export type SweepTake = "scheduled" | "paused" | "unscheduled" | "unreadable";

export interface SweepVerdict {
  /** Whether the minute takes this row at all. */
  takes: boolean;
  /** Which of the four states the row is in — see `SWEEP_TAKES`. */
  take: SweepTake;
  /** The product's own sentence about it, always present so a UI has nothing to invent. */
  reason: string;
  /** The grammar's complaint, when there is one; null for a cadence the matcher reads. */
  problem: string | null;
}

/** The four states a profile can be in, in the order the sweep reaches them. */
export const SWEEP_TAKES = ["scheduled", "paused", "unscheduled", "unreadable"] as const;

/**
 * A row's verdict for one minute of the sweep. `takes` is "this minute acts on the row":
 * false for a paused row, one with no cadence, one whose cadence the matcher cannot read,
 * and one whose cadence does not name this minute — the last of those is the state a working
 * weekly drop sits in for six days and twenty-three hours of the week, and `take` says so.
 */
export function profileSweep(profile: { isActive: boolean; schedule: string | null }, now: Date): SweepVerdict {
  if (!profile.isActive) {
    return { takes: false, take: "paused", reason: "isActive is false, so no minute takes it", problem: null };
  }
  if (profile.schedule === null) {
    return { takes: false, take: "unscheduled", reason: "it declares no cadence, so nothing schedules it", problem: null };
  }
  const problem = scheduleProblem(profile.schedule);
  if (problem !== null) {
    // The scheduler's own warning is built from this string; `tests/unit/export-profile.test.ts`
    // pins the sentence so the two cannot drift apart.
    return { takes: false, take: "unreadable", reason: `active and scheduled, but no minute matches it — ${problem}`, problem };
  }
  const due = matchesSchedule(profile.schedule, now);
  return {
    takes: due,
    take: "scheduled",
    reason: due
      ? `the cadence ${profile.schedule} matches this minute, so the sweep queues an export now`
      : `the cadence ${profile.schedule} is readable, and the sweep takes it whenever a minute matches`,
    problem: null,
  };
}

/**
 * The line the sweep prints for a row it fetched, skipped and must say something about.
 * Kept byte-identical to what `scheduler.ts` printed before this module existed.
 */
export function profileSkipWarning(id: string, verdict: SweepVerdict): string {
  return `Export profile ${id} is ${verdict.reason}`;
}
