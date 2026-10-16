import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { dispatchWebhookEvent } from "./webhooks";
import { asInputJson, asRecord } from "./json";
import { stringify } from "csv-stringify/sync";
import * as XLSX from "xlsx";

export interface ExportConfig {
  format: "CSV" | "JSON" | "XLSX" | "PDF";
  fields: string[];
  filterJson?: any;
  exportId: string;
  [key: string]: any;
}

export async function runExportJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as ExportConfig;
  if (!config?.exportId) throw new Error("Export ID not found in job config");
  const exportRecord = await prisma.export.findUnique({ where: { id: config.exportId } });

  if (!exportRecord) throw new Error("Export record not found");

  await prisma.export.update({ where: { id: exportRecord.id }, data: { status: "PROCESSING" } });

  try {
    const leads = await getLeadsForExport(job.workspaceId, config);
    let filePath: string;
    let fileSize: number;

    switch (config.format) {
      case "CSV":
        filePath = await exportToCSV(leads, config.fields);
        break;
      case "JSON":
        filePath = await exportToJSON(leads, config.fields);
        break;
      case "XLSX":
        filePath = await exportToXLSX(leads, config.fields);
        break;
      case "PDF":
        filePath = await exportToPDF(leads, config.fields);
        break;
      default:
        throw new Error(`Unsupported format: ${config.format}`);
    }

    const stats = await import("fs/promises").then(fs => fs.stat(filePath));

    await prisma.export.update({
      where: { id: exportRecord.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        filePath,
        fileSize: stats.size,
        recordCount: leads.length,
      },
    });

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "COMPLETED", completedAt: new Date(), progress: 100, processedItems: leads.length },
    });

    // Last, after both rows say COMPLETED — a receiver that fetches the export
    // on this event must find the file it names. Best-effort: the dispatcher
    // never throws, so a subscriber's outage is a log line, not a FAILED job
    // for work that actually finished.
    await dispatchWebhookEvent(job.workspaceId, "export.completed", {
      exportId: exportRecord.id,
      format: config.format,
      recordCount: leads.length,
      fileSize: stats.size,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await prisma.export.update({
      where: { id: exportRecord.id },
      data: { status: "FAILED", error: errorMessage },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date(), error: error instanceof Error ? error.message : "Unknown error" },
    });
  }
}

async function getLeadsForExport(workspaceId: string, config: ExportConfig): Promise<any[]> {
  const where: any = { workspaceId };

  if (config.filterJson) {
    // Apply dynamic filters based on filterJson
    // This is simplified - in production would use a proper query builder
  }

  return prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
}

async function exportToCSV(leads: any[], fields: string[]): Promise<string> {
  const rows = leads.map(lead => {
    const row: Record<string, string> = {};
    for (const field of fields) {
      const value = getNestedValue(lead, field);
      row[field] = value === null || value === undefined ? "" : String(value);
    }
    return row;
  });

  const csv = stringify(rows, { header: true });
  const filePath = `/tmp/export_${Date.now()}.csv`;
  await import("fs/promises").then(fs => fs.writeFile(filePath, csv));
  return filePath;
}

async function exportToJSON(leads: any[], fields: string[]): Promise<string> {
  const data = leads.map(lead => {
    const obj: Record<string, any> = {};
    for (const field of fields) {
      obj[field] = getNestedValue(lead, field);
    }
    return obj;
  });

  const json = JSON.stringify(data, null, 2);
  const filePath = `/tmp/export_${Date.now()}.json`;
  await import("fs/promises").then(fs => fs.writeFile(filePath, json));
  return filePath;
}

async function exportToXLSX(leads: any[], fields: string[]): Promise<string> {
  const data = leads.map(lead => {
    const row: Record<string, any> = {};
    for (const field of fields) {
      row[field] = getNestedValue(lead, field);
    }
    return row;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Leads");

  const filePath = `/tmp/export_${Date.now()}.xlsx`;
  XLSX.writeFile(wb, filePath);
  return filePath;
}

async function exportToPDF(leads: any[], fields: string[]): Promise<string> {
  // Would use a PDF library like pdfkit
  // Placeholder for now
  const filePath = `/tmp/export_${Date.now()}.pdf`;
  await import("fs/promises").then(fs => fs.writeFile(filePath, "PDF export placeholder"));
  return filePath;
}

function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((obj, key) => obj?.[key], obj);
}

export async function runScheduledExports(): Promise<void> {
  const now = new Date();
  const profiles = await prisma.exportProfile.findMany({
    where: { isActive: true, schedule: { not: null } },
    include: { workspace: true },
  });

  for (const profile of profiles) {
    if (!profile.schedule) continue;

    const cronParts = profile.schedule.split(" ");
    const currentHour = new Date().getHours();
    if (cronParts[1] !== "*" && parseInt(cronParts[1]) !== currentHour) continue;

    const job = await prisma.job.create({
      data: {
        workspaceId: profile.workspaceId,
        type: "EXPORT",
        status: "PENDING",
        config: { format: profile.format, fields: asInputJson(profile.fields), filterJson: asInputJson(profile.filterJson ?? {}), exportId: "" },
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