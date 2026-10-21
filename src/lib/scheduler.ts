import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { asInputJson, asRecord } from "./json";
import { leadWhere, readStoredConditions } from "./rule-conditions";
import { actionsProblem, readRuleActions } from "./rule-actions";

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
 */
export async function runScheduledJobs(): Promise<void> {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay(); // 0 = Sunday

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

  // Run scheduled enrichment rules
  const rules = await prisma.enrichmentRule.findMany({
    where: { isActive: true, trigger: "SCHEDULED" },
  });

  for (const rule of rules) {
    // The rule's `actions` — "what enrichment to perform", and the cadence it is
    // performed on. This used to hand the whole JSON column to `shouldRunNow` as a
    // cron string, and the object the API requires coerced to `""`: measured, a
    // `SCHEDULED` rule holding `{ fields: ["seniority"] }` queued nothing across
    // three sweep minutes while the same rule with a bare `"* * * * *"` in that
    // column queued one job a minute. Junk in the column now contributes a log line
    // and nothing else, the way junk in `conditions` already does.
    const performed = actionsProblem(rule.actions);
    if (performed !== null) {
      console.warn(`Enrichment rule ${rule.id} skipped: its actions cannot be performed — ${performed}`);
      continue;
    }
    const declared = readRuleActions(rule.actions);
    if (shouldRunNow(declared.schedule ?? "", now)) {
      const stored = readStoredConditions(rule.conditions);
      if (stored.problem !== null) {
        // Nothing was queued and no lead was touched: a blob that cannot be read
        // is not a licence to fall back to the whole workspace.
        console.warn(`Enrichment rule ${rule.id} skipped: conditions cannot be read — ${stored.problem}`);
        continue;
      }
      const leads = await prisma.lead.findMany({
        where: leadWhere(rule.workspaceId, stored.conditions),
        take: 100,
      });

      // The 100 it just counted are the crowd. Carrying only `conditions` meant the
      // worker re-derived the list itself with `take: 1000`, so a rule over a big
      // workspace swept ten times the leads this tick decided to visit — and the row
      // said nothing about either number. The declared field list goes with it: the
      // rule's `actions` say which columns its visits may fill, and an empty list is
      // the rule saying nothing about that, not a rule asking for no columns.
      if (leads.length > 0) {
        const job = await prisma.job.create({
          data: {
            workspaceId: rule.workspaceId,
            type: "ENRICH",
            status: "PENDING",
            config: { providers: Array.isArray(rule.providers) ? (rule.providers as unknown as string[]) : [], fields: declared.fields ?? [], confidenceThreshold: 0.5, conditions: asInputJson(stored.conditions), ruleId: rule.id, leadIds: leads.map((lead) => lead.id) },
            totalItems: leads.length,
          },
        });
        await enqueue(queues.enrich, "run-enrichment", { jobId: job.id });
      }
    }
  }
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