"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { importLeadCsv, MAX_IMPORT_BYTES, type ImportProblem, type LeadImportSummary } from "@/lib/csv-import";

export type ImportState =
  | {
      ok: true;
      message: string;
      imported: number;
      duplicates: number;
      invalid: number;
      /** Up to `MAX_REPORTED_PROBLEMS`; the card shows five and downloads all. */
      problems: ImportProblem[];
      /** True when the file had more problems than the report carries. */
      problemsTruncated: boolean;
    }
  | { ok: false; message: string }
  | null;

/**
 * Import a CSV from the dashboard.
 *
 * The workspace comes from the session, never from the form: a signed-in
 * customer cannot import into someone else's workspace by editing the upload.
 * The file is parsed by the same `importLeadCsv` the API key route uses, so the
 * browser and the API accept exactly the same rows.
 */
export async function importCsvAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const session = await requireSession();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return { ok: false, message: "Choose a CSV file first." };
  }
  if (file.size === 0) {
    return { ok: false, message: "That file is empty." };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      message: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
    };
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: "That file could not be read. Save it as UTF-8 CSV and try again." };
  }

  let result: LeadImportSummary;
  try {
    result = await importLeadCsv(session.workspaceId, text);
  } catch {
    return { ok: false, message: "The import failed before it finished. Nothing was written; try again." };
  }

  if (result.parseError) {
    const where = result.parseError.line ? `Line ${result.parseError.line}: ` : "";
    return { ok: false, message: `${where}${result.parseError.message}` };
  }

  revalidatePath("/dashboard");
  const skipped = result.duplicatesInFile + result.duplicatesExisting;
  return {
    ok: true,
    message: `Imported ${result.imported} of ${result.total} rows. Skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}${
      result.invalid ? ` and ${result.invalid} invalid row${result.invalid === 1 ? "" : "s"}` : ""
    }.`,
    imported: result.imported,
    duplicates: skipped,
    invalid: result.invalid,
    problems: result.problems,
    problemsTruncated: result.problemsTruncated,
  };
}
