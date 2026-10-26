// The pure rules behind an export file: what a filterJson may say, and what a
// cell may contain.
//
// Kept out of `exporter.ts` on purpose: exporter.ts pulls the queue module, so
// the rules that decide what a customer receives are pinned here instead, in
// tests that need no Redis and no database.

import { LEAD_STATUSES } from "./enums";
import { filterWordProblem } from "./list-filter";

/** The filter keys an export accepts — the lead list route's own vocabulary. */
export const EXPORT_FILTER_KEYS = ["status", "minScore", "maxScore", "listId", "tags"] as const;

/**
 * Read `filterJson` as the caller's words, not as truthiness.
 *
 * The exporter used to honour this contract with a comment — `if
 * (config.filterJson) { /* simplified *\/ }` — so an export filtered to
 * `{"status":"QUALIFIED"}` shipped **every lead in the workspace** and still
 * reported COMPLETED. A file that quietly widens is the one mistake a customer
 * is unlikely to catch by eye, so an unsupported key is a FAILED job naming
 * the key, never a wider file.
 */
export function readExportFilter(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('filterJson must be an object like {"status":"QUALIFIED"}');
  }
  const filter = raw as Record<string, unknown>;
  const unsupported = Object.keys(filter).filter(
    (key) => !(EXPORT_FILTER_KEYS as readonly string[]).includes(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `filterJson key ${unsupported.map((k) => JSON.stringify(k)).join(", ")} is not supported — use ${EXPORT_FILTER_KEYS.join(", ")}`,
    );
  }
  const { status, minScore, maxScore, listId, tags } = filter;
  if (status !== undefined && typeof status !== "string") {
    throw new Error("filterJson.status must be a string");
  }
  if (typeof status === "string") {
    // A word the column never holds is not a narrower crowd, it is no crowd.
    // Measured on the running app, `{"status":"ACTIVE"}` and `{"status":"qualified"}`
    // were both a 201 that settled as `COMPLETED records=0 bytes=0` — a delivered
    // file with nothing in it and no refusal anywhere — while the identical body
    // at `POST /api/lead-lists` is a 400 naming the set. One vocabulary, one
    // sentence: this is `filterWordProblem` with the table `conditionsProblem`
    // already uses for a rule's or a list's `status`.
    const problem = filterWordProblem("filterJson.status", status, LEAD_STATUSES);
    if (problem !== null) throw new Error(problem);
  }
  for (const [key, value] of [["minScore", minScore], ["maxScore", maxScore]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`filterJson.${key} must be a whole number from 0 to 100`);
    }
  }
  if (listId !== undefined && typeof listId !== "string") {
    throw new Error("filterJson.listId must be a string");
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length === 0 || tags.some((t) => typeof t !== "string" || t === "")) {
      throw new Error('filterJson.tags must be a non-empty array of tag names, like ["hot"]');
    }
  }
  return filter;
}

/**
 * The same rules, asked before anything is written rather than while the file is.
 *
 * `POST /api/exports` never read its own `filterJson`: measured on the running
 * app, `{"status":"ACTIVE"}` was a 201 that settled as `COMPLETED records=0
 * bytes=0` — a delivered file with nothing in it, reported as a finished export —
 * and `{"temperature":"hot"}` was a 201 that settled as a FAILED job two seconds
 * later. The door that stores "the crowd I mean" and the reader that walks it now
 * ask one question, so both answers arrive as a 400 at the boundary.
 */
export function exportFilterProblem(raw: unknown): string | null {
  try {
    readExportFilter(raw);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One cell value for a file: arrays join, objects serialize, null is empty. */
export function exportCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A CSV cell a spreadsheet cannot turn into a program.
 *
 * Excel and Sheets execute cell text beginning with `=`, `+`, `@`, a tab or a
 * carriage return, so a lead named `=HYPERLINK("http://evil.example","click")`
 * — or tagged `@SUM(1+1)` — is a live formula aimed at whoever opens the
 * export (CWE-1236). Prefix those cells with an apostrophe, the standard text
 * marker. A leading minus is only dangerous when it does not spell a number,
 * so -5 stays the number it is.
 */
export function csvSafeText(value: unknown): string {
  const text = exportCell(value);
  if (/^[=+@\t\r]/.test(text)) return `'${text}`;
  if (text.startsWith("-") && !/^-?\d+(\.\d+)?$/.test(text)) return `'${text}`;
  return text;
}

const PDF_TRANSLITERATIONS: Record<string, string> = {
  "\u2013": "-",
  "\u2014": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u2022": "*",
  "\u2026": "...",
  "\u20AC": "EUR",
};

/**
 * PDF text for the standard fonts, whose encoding is cp1252. Common smart
 * punctuation becomes its ASCII spelling, control characters are dropped, and
 * anything a base-14 font cannot draw (emoji, CJK) becomes `?` — visible
 * losses instead of invisible ones.
 */
export function pdfSafeText(value: unknown): string {
  return exportCell(value)
    .replace(/[\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, (ch) => PDF_TRANSLITERATIONS[ch] ?? ch)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    // `u` mode: an emoji is one code point, so it becomes one visible `?`
    // rather than one per surrogate half.
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/gu, "?");
}
