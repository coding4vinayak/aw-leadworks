import { prisma } from "./db";
import { progressValue } from "./job-report";
import { MARK, isMarked, startWrite, stoppedWrite } from "./job-stop";
import { stoppedExportBytes, stoppedExportWrite } from "./export-stop";
import { dispatchWebhookEvent } from "./webhooks";
import { stringify } from "csv-stringify/sync";
import * as XLSX from "xlsx";
import { csvSafeText, exportCell, pdfSafeText, readExportFilter } from "./export-format";
import { expiryFor } from "./export-retention";

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

  const config = job.config as unknown as ExportConfig;
  if (!config?.exportId) throw new Error("Export ID not found in job config");
  const exportRecord = await prisma.export.findUnique({ where: { id: config.exportId } });

  if (!exportRecord) throw new Error("Export record not found");

  // The mark, obeyed before anything begins: `not: MARK` is in the WHERE, so a cancel that
  // landed after the read above is not overwritten by this worker's own RUNNING. This is the
  // same first write the other three workers make — and until #43 it was the one `grep` said
  // this file did not have: `status: "RUNNING"` unconditionally, then `status: "COMPLETED"`
  // unconditionally, with the operator's mark erased in the 139 ms between them.
  const began = await prisma.job.updateMany({
    where: { id: jobId, status: { not: MARK } },
    data: startWrite(new Date()),
  });
  if (!began.count) {
    await putDownStopped(job.id, exportRecord.id, 0, null);
    return;
  }

  await prisma.export.update({ where: { id: exportRecord.id }, data: { status: "PROCESSING" } });

  // The file this run wrote, once it exists. An export's indivisible unit of work is not a
  // lead — the crowd is one query, rendered in memory, written by one `writeFile` — so a stop
  // here has two shapes, and the second leaves bytes on a disk no row will ever name.
  let writtenFile: string | null = null;

  try {
    const leads = await getLeadsForExport(job.workspaceId, config);

    // The mark, at the boundary before the bytes are produced. Asking here costs one read and
    // saves a file nobody is going to serve: this is the stop that leaves nothing to reclaim.
    if (isMarked(await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }))) {
      await putDownStopped(job.id, exportRecord.id, leads.length, null);
      return;
    }

    let filePath: string;
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
    writtenFile = filePath;

    const stats = await import("fs/promises").then(fs => fs.stat(filePath));

    // Asked after the bytes exist and before any row names them: the mark may have landed
    // while the file was being written. `stoppedExportBytes` is that case's answer — the worker
    // takes back the file it made through the same guard that decides what
    // `DELETE /api/exports/{id}` may remove, so it deletes nothing it cannot prove it wrote.
    if (isMarked(await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }))) {
      await putDownStopped(job.id, exportRecord.id, leads.length, writtenFile);
      return;
    }

    const finishedAt = new Date();
    // One moment, both facts: the row that names the file is the row that says
    // how long it lives. `expiryFor` reads `EXPORT_RETENTION_MS` here rather
    // than at download time, so the lifetime belongs to the export and a
    // retention changed later cannot quietly retire files already written.
    await prisma.export.update({
      where: { id: exportRecord.id },
      data: {
        status: "COMPLETED",
        completedAt: finishedAt,
        expiresAt: expiryFor(finishedAt),
        filePath,
        fileSize: stats.size,
        recordCount: leads.length,
      },
    });

    const counters = { total: leads.length, processed: leads.length, failed: 0 };
    const finish = await prisma.job.updateMany({
      // A finish writes around the mark, so a cancel that landed while the file was being
      // written is not answered with a COMPLETED. `count: 0` here means the Export row has just
      // been stamped for a file whose job the operator stopped, so both rows are put down again
      // — the pointer included — and the bytes come back.
      where: { id: job.id, status: { not: MARK } },
      data: {
        status: "COMPLETED", completedAt: new Date(),
        totalItems: leads.length,
        progress: progressValue(counters),
        processedItems: leads.length,
      },
    });
    if (!finish.count) {
      await putDownStopped(job.id, exportRecord.id, leads.length, writtenFile);
      return;
    }

    // Last, after both rows say COMPLETED — a receiver that fetches the export
    // on this event must find the file it names. Best-effort: the dispatcher
    // never throws, so a subscriber's outage is a log line, not a FAILED job
    // for work that actually finished. A stopped run never reaches this line:
    // an `export.completed` for a file its operator cancelled is a delivery of
    // bytes that are on their way to the disk's trash, and the wire cannot tell
    // that story from a finished one.
    await dispatchWebhookEvent(job.workspaceId, "export.completed", {
      exportId: exportRecord.id,
      format: config.format,
      recordCount: leads.length,
      fileSize: stats.size,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    // An error is this worker's own word, and it does not outrank the operator's: a run that
    // threw after a mark landed puts its record down as stopped, not as broken, and still takes
    // back the bytes it wrote before the throw.
    if (isMarked(await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } }))) {
      await putDownStopped(job.id, exportRecord.id, 0, writtenFile);
      return;
    }
    await prisma.export.update({
      where: { id: exportRecord.id },
      data: { status: "FAILED", error: errorMessage },
    });
    await prisma.job.updateMany({
      where: { id: job.id, status: { not: MARK } },
      data: { status: "FAILED", completedAt: new Date(), error: errorMessage },
    });
  }
}

/**
 * Both rows of one export, put down because the operator said stop, and the bytes taken back
 * if this run made them.
 *
 * The order is the only one that cannot lie: the disk first, then the record, then the job. If
 * the `unlink` fails the file stays and the reason is printed — a stopped export whose residue
 * is counted by #37's census is an honest accident, and a silent one is the bug that round was
 * written to end. The job write carries `status: MARK` in its WHERE, so this puts a marked row
 * down under its own mark and never walks a status back from anything else.
 */
async function putDownStopped(
  jobId: string,
  exportId: string,
  total: number,
  filePath: string | null,
): Promise<void> {
  const bytes = stoppedExportBytes(filePath);
  if (bytes.action === "unlink") {
    try {
      await import("fs/promises").then(fs => fs.unlink(bytes.filePath));
      console.log(`Export ${exportId}: stopped run's file removed at ${bytes.filePath}`);
    } catch (error) {
      console.log(`Export ${exportId}: stopped run's file left on disk at ${bytes.filePath} (${error instanceof Error ? error.message : String(error)})`);
    }
  } else if (filePath) {
    console.log(`Export ${exportId}: bytes a stopped run wrote were left alone — ${bytes.reason}`);
  }

  await prisma.export.update({ where: { id: exportId }, data: stoppedExportWrite() });
  await prisma.job.updateMany({
    where: { id: jobId, status: MARK },
    data: stoppedWrite({ total, processed: 0, failed: 0 }, new Date()),
  });
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
