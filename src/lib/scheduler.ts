import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { asInputJson, asRecord } from "./json";
import { leadWhere, readStoredConditions } from "./rule-conditions";
import { actionsProblem, readRuleActions } from "./rule-actions";
import { RULE_PRIORITY_ORDER, planTick, type DueRule } from "./rule-priority";
import { planPurge, purgedExportLog } from "./export-retention";
import { unlink } from "fs/promises";

/**
 * One minute's worth of the schedule: every active source, export profile and SCHEDULED
 * enrichment rule whose cron matches the current wall clock, turned into the `Job` rows
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
 * that misbehaves cannot cost the minute's work, and it is the only `unlink` in `src/` — the
 * decision over which paths qualify is `lib/export-retention.ts`'s `planPurge`, and this file
 * only ever acts on what that returns.
 */
export async function runScheduledJobs(): Promise<void> {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay(); // 0 = Sunday

  // Its own error, its own line: a filesystem or a query that misbehaves here must not cost
  // the sources, profiles and rules this minute is due for, and a retired export that is not
  // reclaimed at 08:00 is reclaimed at 08:01.
  try {
    await purgeRetiredExports(now);
  } catch (error) {
    console.warn(`Retired export purge did not run this minute: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Find all active sources with schedules
  const sources = await prisma.source.findMany({
    where: { isActive: true, schedule: { not: null } },
  });

  for (const source of sources) {
    if (!source.schedule) continue;
    if (shouldRunNow(source.schedule, now)) {
      const job = await prisma.job.create({
        data: {
          workspaceId: source.workspaceId,
          sourceId: source.id,
          type: "SCRAPE",
          status: "PENDING",
          config: asInputJson(source.config),
        },
      });
      await enqueue(queues.scrape, "run-scrape", { jobId: job.id });
    }
  }

  // Find active export profiles with schedules
  const exportProfiles = await prisma.exportProfile.findMany({
    where: { isActive: true, schedule: { not: null } },
  });

  for (const profile of exportProfiles) {
    if (!profile.schedule) continue;
    if (shouldRunNow(profile.schedule, now)) {
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

      await enqueue(queues.export, "run-export", { jobId: job.id });
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
  // The `actions` half used to hand the whole JSON column to `shouldRunNow` as a cron
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
    if (!shouldRunNow(declared.schedule ?? "", now)) continue;
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
      await enqueue(queues.enrich, "run-enrichment", { jobId: job.id });
    }
  }
}

export type PurgeReport = { removed: number; alreadyGone: number; refused: number; failed: number; considered: number };

/**
 * The one `unlink` in this application. It reads the rows a retention could judge —
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

function shouldRunNow(cronExpression: string, now: Date): boolean {
  // Simplified cron matching - in production use croner or similar
  const parts = cronExpression.split(" ");
  if (parts.length < 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const nowMinute = now.getMinutes();
  const nowHour = now.getHours();
  const nowDayOfMonth = now.getDate();
  const nowMonth = now.getMonth() + 1;
  const nowDayOfWeek = now.getDay();

  const minuteMatch = minute === "*" || minute.split(",").includes(nowMinute.toString());
  const hourMatch = hour === "*" || hour.split(",").includes(nowHour.toString());
  const dayOfMonthMatch = dayOfMonth === "*" || dayOfMonth.split(",").includes(now.getDate().toString());
  const monthMatch = month === "*" || month.split(",").includes(nowMonth.toString());
  const dayOfWeekMatch = dayOfWeek === "*" || dayOfWeek.split(",").includes(now.getDay().toString());

  return minuteMatch && hourMatch && dayOfMonthMatch && monthMatch && dayOfWeekMatch;
}