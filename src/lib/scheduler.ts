import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { asInputJson, asRecord } from "./json";

/**
 * One minute's worth of the schedule: every active source, export profile and SCHEDULED
 * enrichment rule whose cron matches the current wall clock, turned into the `Job` rows
 * and queue entries they describe. The `scheduled` worker's handler is its only call site,
 * and `registerScheduledSweep()` in `queue.ts` is what produces the jobs that handler waits
 * for.
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
    if (shouldRunNow(typeof rule.actions === "string" ? rule.actions : "", now)) { // schedule stored in actions for now
      const leads = await prisma.lead.findMany({
        where: { workspaceId: rule.workspaceId, status: { in: ["NEW", "ENRICHED"] } },
        take: 100,
      });

      if (leads.length > 0) {
        const job = await prisma.job.create({
          data: {
            workspaceId: rule.workspaceId,
            type: "ENRICH",
            status: "PENDING",
            config: { providers: Array.isArray(rule.providers) ? (rule.providers as unknown as string[]) : [], fields: [], confidenceThreshold: 0.5 },
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