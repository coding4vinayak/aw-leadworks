import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { dispatchWebhookEvent } from "./webhooks";
import { asInputJson, asRecord } from "./json";
import { stringify } from "csv-stringify/sync";
import * as XLSX from "xlsx";
import { csvSafeText, exportCell, pdfSafeText, readExportFilter } from "./export-format";

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
  const filter = readExportFilter(config.filterJson);
  const where: any = { workspaceId };

  if (typeof filter.status === "string") where.status = filter.status;
  if (typeof filter.minScore === "number" || typeof filter.maxScore === "number") {
    where.score = {
      ...(typeof filter.minScore === "number" ? { gte: filter.minScore } : {}),
      ...(typeof filter.maxScore === "number" ? { lte: filter.maxScore } : {}),
    };
  }
  if (typeof filter.listId === "string") where.listMemberships = { some: { listId: filter.listId } };
  if (Array.isArray(filter.tags) && filter.tags.length > 0) where.tags = { array_contains: filter.tags };

  return prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
}

async function exportToCSV(leads: any[], fields: string[]): Promise<string> {
  const rows = leads.map(lead => {
    const row: Record<string, string> = {};
    for (const field of fields) {
      // csvSafeText, not String: a cell a spreadsheet would execute is the one
      // export bug that attacks the customer instead of annoying them.
      row[field] = csvSafeText(getNestedValue(lead, field));
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

/**
 * XLSX without SheetJS's `writeFile`, which cannot save anything in the build
 * Next produces: `import * as XLSX from "xlsx"` resolves to SheetJS's ESM
 * bundle, whose `writeFile` has no way to reach Node's fs and threw "cannot
 * save file …" for every XLSX export. `write` needs no fs, so the bytes come
 * back here and land on disk through fs directly. Array cells (tags) are
 * flattened to text first, because json_to_sheet otherwise stores the raw
 * array as the cell value — not a cell any spreadsheet can read.
 */
async function exportToXLSX(leads: any[], fields: string[]): Promise<string> {
  const data = leads.map(lead => {
    const row: Record<string, any> = {};
    for (const field of fields) {
      const value = getNestedValue(lead, field);
      row[field] =
        Array.isArray(value) || (value !== null && typeof value === "object")
          ? exportCell(value)
          : value;
    }
    return row;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Leads");

  const filePath = `/tmp/export_${Date.now()}.xlsx`;
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  await import("fs/promises").then(fs => fs.writeFile(filePath, Buffer.from(bytes)));
  return filePath;
}

/**
 * A real PDF, not the placeholder string this used to write into a `.pdf`:
 * the README promises "Exports land in CSV, JSON, XLSX or PDF", and a customer
 * who chose PDF got a text file saying "PDF export placeholder". One lead per
 * block, the chosen fields, page numbers, and the same filtered set as every
 * other format.
 */
async function exportToPDF(leads: any[], fields: string[]): Promise<string> {
  const filePath = `/tmp/export_${Date.now()}.pdf`;
  const PDFDocument = (await import("pdfkit")).default;
  const { createWriteStream } = await import("node:fs");

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      bufferPages: true,
      info: { Title: "LeadWorks export", Author: "LeadWorks" },
    });
    const stream = createWriteStream(filePath);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.pipe(stream);

    doc.fontSize(16).text("Lead list export");
    doc.moveDown(0.25);
    doc
      .fontSize(9)
      .fillColor("#444444")
      .text(
        `${leads.length} lead${leads.length === 1 ? "" : "s"} · fields: ${fields.join(", ")} · generated ${new Date().toISOString()}`,
      );
    doc.moveDown(0.75).fillColor("#000000");

    if (leads.length === 0) {
      doc.fontSize(10).text("No leads matched this export's filter.");
    }

    leads.forEach((lead, index) => {
      const line = fields
        .map((field) => `${field}: ${pdfSafeText(getNestedValue(lead, field)) || "—"}`)
        .join("  ·  ");
      doc.fontSize(9.5).text(`${index + 1}. ${line}`, { paragraphGap: 4 });
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#666666")
        .text(`LeadWorks · page ${i + 1} of ${range.count}`, 40, doc.page.height - 50, {
          width: doc.page.width - 80,
          align: "right",
        });
    }

    doc.end();
  });

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