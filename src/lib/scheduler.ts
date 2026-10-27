import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { enqueueOrMark, markExportNeverQueued } from "./queue-refusal";
import { asInputJson, asRecord } from "./json";
import { leadWhere, readStoredConditions } from "./rule-conditions";
import { actionsProblem, readRuleActions } from "./rule-actions";
import { matchesSchedule, scheduleProblem } from "./cron-schedule";
import { RULE_PRIORITY_ORDER, planTick, type DueRule } from "./rule-priority";
import {
  censusLog,
  planPurge,
  purgedExportLog,
  unclaimedExportFiles,
  type DiskFile,
  type UnclaimedCensus,
} from "./export-retention";
import { readdir, stat, unlink } from "fs/promises";

/**
 * One minute's worth of the schedule: every active source, export profile and SCHEDULED
 * enrichment rule whose cron matches the current wall clock — read by `cron-schedule.ts`,
 * the one matcher and the one grammar the doors refuse with, turned into the `Job` rows
 * and queue entries they describe. The `scheduled` worker's handler is its only call site,
 * and `registerScheduledSweep()` in `queue.ts` is what produces the jobs that handler waits
 * for.
 *
 * A rule's `conditions` decide which leads its job is about: the same
 * `leadWhere` the enrichment worker applies to that job's config comes from here, so the
 * minute that queues the work and the worker that does it cannot pick different crowds.
 * A rule whose stored conditions cannot be read contributes a log line and nothing else.
 * Its `actions` decide the other two things about that job — the cadence this minute is
 * matched against, and the columns the visit may fill — read by `lib/rule-actions.ts`,
 * which refuses a schedule this matcher could never match at the door that stored it.
 *
 * And when two rules are due for the same lead in the same minute, `priority` says which
 * one visits it: the due set goes through `lib/rule-priority.ts`, which walks the ranking
 * and lets each rule claim the columns it asked for before the next one is considered.
 * Without that walk the ranking decided nothing at all, whatever the query's `orderBy`
 * said, because the `enrich` worker runs five jobs at once and the column went to whichever
 * write landed first.
 *
 * One leg of the sweep queues nothing: it reclaims the bytes of exports whose `expiresAt`
 * has passed, `purgeRetiredExports()` below. It rides the same minute because retention is a
 * thing that has to happen even when nothing is due, it runs before the calendar so a disk
 * that misbehaves cannot cost the minute's work, and the decision over which paths qualify is
 * `lib/export-retention.ts`'s `planPurge` — this file only ever acts on what that returns.
 *
 * A second leg reads the disk and the table and deletes nothing: `logExportFileCensus()`
 * counts the export-shaped files no row names and prints the number when it moves. `#36` left
 * 24 of them uncounted and unmentioned, which is how a round gets to attribute a number it had
 * never looked at.
 */
export async function runScheduledJobs(): Promise<void> {
  const now = new Date();

  // Its own error, its own line: a filesystem or a query that misbehaves here must not cost
  // the sources, profiles and rules this minute is due for, and a retired export that is not
  // reclaimed at 08:00 is reclaimed at 08:01.
  try {
    await purgeRetiredExports(now);
  } catch (error) {
    console.warn(`Retired export purge did not run this minute: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Its own error, its own line, for the same reason: this one reads a directory and a table to
  // produce a number, and a minute in which it cannot do either is still a minute the sources,
  // profiles and rules are due for. It is the round's honesty leg — the count that #36 guessed at
  // is now one the server prints.
  try {
    await logExportFileCensus(now);
  } catch (error) {
    console.warn(`Export file census did not run this minute: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Find all active sources with schedules
  const sources = await prisma.source.findMany({
    where: { isActive: true, schedule: { not: null } },
  });

  for (const source of sources) {
    if (!source.schedule) continue;
    // A cadence no minute can equal used to be indistinguishable from a quiet week: #38
    // measured a `*/5 * * * *` that stored as 201 and minted nothing across four sweep
    // minutes, while the same string was refused with a 400 at the rule door. The door
    // refuses one now; this line is for the rows written before it did.
    const unreadable = scheduleProblem(source.schedule);
    if (unreadable !== null) {
      console.warn(`Source ${source.id} is active and scheduled, but no minute matches it — ${unreadable}`);
      continue;
    }
    if (matchesSchedule(source.schedule, now)) {
      const job = await prisma.job.create({
        data: {
          workspaceId: source.workspaceId,
          sourceId: source.id,
          type: "SCRAPE",
          status: "PENDING",
          config: asInputJson(source.config),
        },
      });
      await enqueueOrMark(job.id, () => enqueue(queues.scrape, "run-scrape", { jobId: job.id }));
    }
  }

  // Find active export profiles with schedules
  const exportProfiles = await prisma.exportProfile.findMany({
    where: { isActive: true, schedule: { not: null } },
  });

  for (const profile of exportProfiles) {
    if (!profile.schedule) continue;
    // Named and skipped, the way a source is: a weekly drop whose cadence the matcher
    // cannot read is a weekly drop that never happens, and the profile says it is active.
    const unreadable = scheduleProblem(profile.schedule);
    if (unreadable !== null) {
      console.warn(`Export profile ${profile.id} is active and scheduled, but no minute matches it — ${unreadable}`);
      continue;
    }
    if (matchesSchedule(profile.schedule, now)) {
      const job = await prisma.job.create({
        data: {
          workspaceId: profile.workspaceId,
          type: "EXPORT",
          status: "PENDING",
          config: { format: profile.format, fields: asInputJson(profile.fields), ...(profile.filterJson != null ? { filterJson: asInputJson(profile.filterJson) } : {}), exportId: "" },
        },
      });

      const exportRecord = await prisma.export.create({
        data: {
          workspaceId: profile.workspaceId,
          profileId: profile.id,
          format: profile.format,
          fields: asInputJson(profile.fields),
          ...(profile.filterJson != null ? { filterJson: asInputJson(profile.filterJson) } : {}),
          status: "PENDING",
        },
      });

      await prisma.job.update({ where: { id: job.id }, data: { config: { ...asRecord(job.config), exportId: exportRecord.id } } });
      await prisma.export.update({ where: { id: exportRecord.id }, data: { status: "PENDING" } });

      const handed = await enqueueOrMark(job.id, () => enqueue(queues.export, "run-export", { jobId: job.id }));
      // The `Export` row is paired with this job, and the door built to re-run it reads
      // "Can only retry failed exports" for a `PENDING` one — so a refusal takes both rows
      // terminal, or the export is stranded in a state no door will move.
      if (!handed) await markExportNeverQueued(exportRecord.id);
    }
  }

  const rules = await prisma.enrichmentRule.findMany({
    where: { isActive: true, trigger: "SCHEDULED" },
    orderBy: RULE_PRIORITY_ORDER,
  });

  // What this minute is actually due for, before any ranking. A rule whose declaration
  // cannot be performed, whose cadence does not match this minute, or whose conditions
  // cannot be read contributes a log line and is not in the running — and does not get to
  // claim columns it will never visit.
  //
  // The `actions` half used to hand the whole JSON column to the minute matcher as a cron
  // string, and the object the API requires coerced to `""`: measured, a `SCHEDULED` rule
  // holding `{ fields: ["seniority"] }` queued nothing across three sweep minutes while the
  // same rule with a bare `"* * * * *"` in that column queued one job a minute. Junk in the
  // column now contributes a log line and nothing else, the way junk in `conditions` does.
  const due: DueRule[] = [];
  for (const rule of rules) {
    const performed = actionsProblem(rule.actions);
    if (performed !== null) {
      console.warn(`Enrichment rule ${rule.id} skipped: its actions cannot be performed — ${performed}`);
      continue;
    }
    const declared = readRuleActions(rule.actions);
    if (!matchesSchedule(declared.schedule ?? "", now)) continue;
    const stored = readStoredConditions(rule.conditions);
    if (stored.problem !== null) {
      // Nothing was queued and no lead was touched: a blob that cannot be read
      // is not a licence to fall back to the whole workspace.
      console.warn(`Enrichment rule ${rule.id} skipped: conditions cannot be read — ${stored.problem}`);
      continue;
    }
    due.push({
      id: rule.id,
      workspaceId: rule.workspaceId,
      createdAt: rule.createdAt,
      priority: rule.priority,
      actions: rule.actions,
      providers: Array.isArray(rule.providers) ? (rule.providers as unknown as string[]) : [],
      conditions: stored.conditions,
    });
  }

  // The ranking, walked. Every rule here is due; the order they are queued in decides
  // nothing on its own — the `enrich` worker takes five jobs at once — so what `priority`
  // settles is who owns which column this minute, and a rule left with nothing queues
  // nothing at all.
  const plan = planTick(due);
  for (const starved of plan.starved) {
    // No job, no log row — so nothing recorded against `creditsUsed` — and no stamp: this
    // rule visited nobody. The ranking is what said so, and the sentence belongs in the log
    // rather than in a record of a visit that did not happen.
    console.info(
      `Enrichment rule ${starved.rule.id} queued nothing this minute: every column ${
        starved.asked === null ? "it could write" : `it asked for (${starved.asked.join(", ")})`
      } is owned this minute by a higher-ranked rule`,
    );
  }

  for (const { rule, fields } of plan.visits) {
    const leads = await prisma.lead.findMany({
      where: leadWhere(rule.workspaceId, rule.conditions),
      take: 100,
    });

    // The 100 it just counted are the crowd. Carrying only `conditions` meant the
    // worker re-derived the list itself with `take: 1000`, so a rule over a big
    // workspace swept ten times the leads this tick decided to visit — and the row
    // said nothing about either number. The field list on the job is what this rule
    // owns after the ranking, never the whole set it merely asked for: the columns a
    // higher-ranked rule claimed are not written twice in one minute.
    if (leads.length > 0) {
      const job = await prisma.job.create({
        data: {
          workspaceId: rule.workspaceId,
          type: "ENRICH",
          status: "PENDING",
          config: { providers: rule.providers, fields, confidenceThreshold: 0.5, conditions: asInputJson(rule.conditions), ruleId: rule.id, leadIds: leads.map((lead) => lead.id) },
          totalItems: leads.length,
        },
      });
      await enqueueOrMark(job.id, () => enqueue(queues.enrich, "run-enrichment", { jobId: job.id }));
    }
  }
}

export type PurgeReport = { removed: number; alreadyGone: number; refused: number; failed: number; considered: number };

/**
 * One of this application's three `unlink` sites, and the only one that acts on a date. (The other
 * two take their authority from somewhere else: `DELETE /api/exports/{id}` removes a file with the
 * row that named it, because its caller owns that row, and `lib/exporter.ts` removes the bytes a
 * run it stopped wrote in the same breath.) All three consult the same guard in
 * `lib/export-retention.ts`, so "we only delete files this app wrote at a path of its own shape" is
 * one rule with three callers.
 *
 * It reads the rows a retention could judge —
 * finished, stamped, dated — hands them to `planPurge` and deletes only what that returns,
 * so the path it removes has passed the date check and the `/tmp/export_<digits>.<ext>`
 * shape check in the pure module first. `filePath`, `fileSize` and the `COMPLETED` status all
 * stay on the row: it is the record of an export that happened, and the date on it is what
 * says the bytes are gone.
 *
 * A file that is already absent is not a failure. `/tmp` is reclaimed by the operating
 * system on its own schedule and the download door has always answered its own sentence when
 * that happened; this sweep counts it separately rather than pretending it deleted something.
 */
export async function purgeRetiredExports(now: Date = new Date()): Promise<PurgeReport> {
  const rows = await prisma.export.findMany({
    where: { status: "COMPLETED", expiresAt: { not: null, lte: now } },
    select: { id: true, filePath: true, expiresAt: true },
  });
  const plan = planPurge(rows, now);
  const report: PurgeReport = { removed: 0, alreadyGone: 0, refused: plan.keep.length, failed: 0, considered: rows.length };

  for (const target of plan.remove) {
    try {
      await unlink(target.filePath);
      report.removed += 1;
      console.info(purgedExportLog(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        report.alreadyGone += 1;
        console.info(`Export ${target.id}: retired file at ${target.filePath} was already gone from this server`);
      } else {
        report.failed += 1;
        console.warn(`Export ${target.id}: retired file at ${target.filePath} could not be removed — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return report;
}

/**
 * An export file, seen by name only. `unclaimedExportFiles` re-checks this shape against the
 * absolute path it is handed; this filter exists so `/tmp`'s other 300-odd entries are never
 * stat'ed for a count that is about exports.
 */
const EXPORT_FILE_NAME = /^export_\d+\.(csv|json|xlsx|pdf)$/;

/**
 * What is on the disk and not in the table: every `/tmp/export_<digits>.<ext>` no `Export` row
 * names, plus the ones too young to judge. Read-only — this function cannot ask a question that
 * deletes anything, and `unclaimedExportFiles` cannot answer one.
 *
 * A file with no row has no `expiresAt`, no `status` and no `workspaceId`. That is the reason the
 * census is a log line and not a door: there is no retention to apply to it and no tenant whose
 * authorization could be checked for it, and the in-flight window (a path exists 2.3-16.1 ms
 * before the row that names it) means the set is not even stable to act on. So the app counts it,
 * says the number out loud once a minute when it moves, and leaves the bytes to whoever owns them.
 */
export async function exportFileCensus(now: Date = new Date()): Promise<UnclaimedCensus> {
  const [entries, rows] = await Promise.all([
    readdir("/tmp", { withFileTypes: true }),
    prisma.export.findMany({ select: { filePath: true } }),
  ]);
  const listed = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && EXPORT_FILE_NAME.test(entry.name))
      .map(async (entry): Promise<DiskFile | null> => {
        const path = `/tmp/${entry.name}`;
        try {
          return { path, bytes: (await stat(path)).size };
        } catch {
          // Reclaimed between the listing and the stat: there are no bytes here to count.
          return null;
        }
      }),
  );
  const named = rows
    .map((row) => row.filePath)
    .filter((filePath): filePath is string => Boolean(filePath));
  return unclaimedExportFiles(
    listed.filter((file): file is DiskFile => file !== null),
    named,
    now,
  );
}

let lastCensusLine: string | null = null;

/**
 * The sweep's visibility leg. The census runs every minute and prints when the sentence changes,
 * because a number that has not moved is not news and 1,440 identical lines a day would bury the
 * removals the same sweep logs. The first minute of any instance always prints: that is the point
 * of the round — an operator who never saw this count now sees it without asking.
 */
export async function logExportFileCensus(now: Date = new Date()): Promise<UnclaimedCensus> {
  const census = await exportFileCensus(now);
  const line = censusLog(census);
  if (line !== lastCensusLine) {
    lastCensusLine = line;
    console.info(line);
  }
  return census;
}
