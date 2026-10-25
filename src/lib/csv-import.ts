import { prisma } from "./db";
import { dispatchWebhookBatch, emptyTally, type DeliveryTally } from "./webhooks";
import { parseLeadCsv } from "./csv-parse";
import { MAX_REPORTED_PROBLEMS } from "./import-limits";
import { scoredWriteData } from "./lead-score";
import type { ParsedLeadCsv } from "./csv-parse";

/**
 * The writing half of CSV import. Parsing and row rules live in `csv-parse.ts`
 * (pure, unit-tested); this file decides what to do with the rows that passed:
 * skip addresses the workspace already holds, insert the rest, and emit the same
 * `lead.created` event a single `POST /api/leads` emits.
 */

export { MAX_IMPORT_BYTES } from "./import-limits";
export { MAX_IMPORT_ROWS, MAX_REPORTED_PROBLEMS, parseLeadCsv } from "./csv-parse";
export type {
  ImportProblem,
  LeadImportFields,
  ParsedLeadCsv,
  ParsedLeadRow,
} from "./csv-parse";

export type LeadImportSummary = {
  imported: number;
  total: number;
  invalid: number;
  duplicatesInFile: number;
  duplicatesExisting: number;
  problems: ParsedLeadCsv["problems"];
  problemsTruncated: boolean;
  /** What the `lead.created` fan-out did, counted per attempt. Zero when nothing was emitted. */
  webhooks: DeliveryTally;
  parseError?: { line: number | null; message: string };
};

/**
 * Insert the valid rows, skipping addresses the workspace already holds.
 *
 * `webhooks` is in every return, including the two that created nothing: the key
 * is the answer to "did my subscribers get this", and a report that carries it
 * only on some files is a report whose absence means three different things.
 */
export async function importLeadCsv(workspaceId: string, text: string): Promise<LeadImportSummary> {
  const parsed = parseLeadCsv(text);
  const report = {
    total: parsed.total,
    invalid: parsed.invalidRows,
    duplicatesInFile: parsed.duplicatesInFile.length,
    problems: parsed.problems.slice(0, MAX_REPORTED_PROBLEMS),
    problemsTruncated: parsed.problems.length > MAX_REPORTED_PROBLEMS,
    webhooks: emptyTally(),
  };
  if (parsed.parseError) {
    return { imported: 0, duplicatesExisting: 0, ...report, parseError: parsed.parseError };
  }

  // The unique index is `[workspaceId, email]`, so that is the duplicate the
  // product actually refuses. Case is folded here because the index is not:
  // importing `John@X.com` when `john@x.com` exists would otherwise create a
  // second row the product treats as a different person.
  const emails = [...new Set(parsed.rows.map((r) => r.email).filter((e): e is string => !!e))];
  const existing = emails.length
    ? await prisma.lead.findMany({
        where: { workspaceId, email: { in: emails, mode: "insensitive" } },
        select: { email: true },
      })
    : [];
  const existingEmails = new Set(
    existing.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean),
  );
  const fresh = parsed.rows.filter((r) => !(r.email && existingEmails.has(r.email)));
  const duplicatesExisting = parsed.rows.length - fresh.length;

  if (fresh.length === 0) {
    return { imported: 0, duplicatesExisting, ...report };
  }

  const created = await prisma.lead.createManyAndReturn({
    data: fresh.map((r) => ({
      workspaceId,
      ...r.data,
      // Required Json columns: a CSV with no tags still needs the array.
      technologies: r.data.technologies ?? [],
      intentSignals: r.data.intentSignals ?? [],
      tags: r.data.tags ?? [],
      status: "NEW",
      // The whole point of an importer is that the buyer's list arrives scored
      // rather than at the column default of 0, which is what it did: the demo's
      // three imported contacts carried an email, a company, a title, a location,
      // a country and an industry and still sat at the bottom of every
      // `orderBy: score desc` read. The row's signals are all here, so the score is
      // computed with the row, in the same insert.
      ...scoredWriteData(r.data),
    })),
    skipDuplicates: true,
  });
  // A concurrent import can still lose a race the unique index settles; count
  // those in the same "duplicate" bucket so the report always adds up.
  const skippedByDb = fresh.length - created.length;

  // One `lead.created` per row, the same contract a single POST honors. The
  // contract says an event per row; it never said the events are delivered one
  // at a time, and delivering them that way is what #53 measured: a file of 20
  // fresh rows against a subscription that accepts the socket and never answers
  // cost the import door 100.19 s — the 5 s attempt budget times the crowd — while
  // the same rows against a subscription that answers in 300 ms cost 6.22 s. The
  // rows are already committed either way, so what the fan-out decides is only how
  // long the caller waits, and the attempts are independent of one another.
  //
  // `webhooks` carries the count of what the fan-out did, because a file whose
  // 20 events all drew a 500 from the subscriber and a file with no subscription
  // at both ends used to answer with the same bytes: `imported: 20` and stdout,
  // which the caller cannot read. A lookup failure here is still logged and never
  // turned into a 500 the caller would retry and duplicate.
  if (created.length) {
    try {
      report.webhooks = await dispatchWebhookBatch(workspaceId, "lead.created", created);
    } catch (error) {
      console.error("[import] webhook dispatch failed:", error);
    }
  }

  return {
    imported: created.length,
    duplicatesExisting: duplicatesExisting + skippedByDb,
    ...report,
  };
}
