// The pure rules behind an export file: what a filterJson may say, and what a
// cell may contain.
//
// Kept out of `exporter.ts` on purpose: exporter.ts pulls the queue module, so
// the rules that decide what a customer receives are pinned here instead, in
// tests that need no Redis and no database.
import { wholeScoreProblem } from "./score-range";

import { LEAD_STATUSES } from "./enums";
import { filterWordProblem } from "./list-filter";

/** The filter keys an export accepts — the lead list route's own vocabulary. */
export const EXPORT_FILTER_KEYS = ["status", "minScore", "maxScore", "listId", "tags"] as const;

/**
 * What the refusal calls this key: `filterJson.listId`, the place the value arrived,
 * the way `filterJson.status` is named in the sentence `readExportFilter` throws for a
 * wrong word. One name for three callers — the shape refusal, the empty-name refusal,
 * and the door's 422 — because the alternative is a sentence an integrator has to
 * learn twice, and a test cannot tell the two apart.
 */
export const EXPORT_LIST_ID = "filterJson.listId";

/**
 * Read `filterJson` as the caller's words, not as truthiness.
 *
 * The exporter used to honour this contract with a comment — `if
 * (config.filterJson) { /* simplified *\/ }` — so an export filtered to
 * `{"status":"QUALIFIED"}` shipped **every lead in the workspace** and still
 * reported COMPLETED. A file that quietly widens is the one mistake a customer
 * is unlikely to catch by eye, so an unsupported key is a FAILED job naming
 * the key, never a wider file.
 *
 * The door that *stores* the blob honoured it the same way with nothing at all:
 * measured on the running app, `{"status":"ACTIVE"}` was a 201 that settled as
 * `COMPLETED records=0 bytes=0` — a delivered file with nothing in it, reported as
 * a finished export — and `{"temperature":"hot"}` was a 201 that settled as a
 * FAILED job two seconds later. The door that stores "the crowd I mean" and the
 * reader that walks it ask one question now, through this function, so both answers
 * arrive at the boundary: the shape as a 400, and a name that resolves nowhere as a
 * 422 (see `POST /api/exports`, which is where the database is reachable from).
 */
export function readExportFilter(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('filterJson must be an object like {"status":"QUALIFIED"}');
  }
  let filter = raw as Record<string, unknown>;
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
    // The sentence is `score-range.ts`'s, because the lead read door takes the same two bounds
    // off a query string and must not answer a different rule for the same number.
    const problem = wholeScoreProblem(`filterJson.${key}`, value);
    if (problem !== null) {
      throw new Error(problem);
    }
  }
  if (listId !== undefined && typeof listId !== "string") {
    throw new Error(`${EXPORT_LIST_ID} must be a string`);
  }
  if (typeof listId === "string") {
    // `listId` names a row rather than a value in a column, so the two decisions every
    // id in this API already travels with come with it: padding is not part of the id,
    // and an empty string names nothing. Measured on this round's runtime before either
    // was honoured — over a workspace of three leads and a list holding two of them —
    // `{"listId":"  lst_r69_a  "}` for a list that exists and `{"listId":""}` each
    // settled as `COMPLETED recordCount=0 fileSize=0`, and the download that followed was
    // a 200 with **zero bytes** in it, not even the header line `{"listId":"lst_r69_a"}`
    // correctly produces. The same padded bytes at the read door —
    // `GET /api/leads?listId=%20lst_r69_a%20` — answered that list's two leads, because
    // `idFilterParam` trims. `stringList`/`asStrings` trim the same bytes for `listIds`,
    // and a body that asks to file a lead under `""` is a 400 — "every listIds entry
    // must be a non-empty string". Whether the stripped name *exists* is not this
    // function's question — it needs the database, and the door asks it — but what the
    // caller meant by the bytes is. (The zero bytes quoted above were the base build's
    // second defect, since fixed: an empty crowd's CSV carries its declared header line.)
    const named = listId.trim();
    if (named === "") throw new Error(`${EXPORT_LIST_ID} must name a list; "" is not a list`);
    if (named !== listId) filter = { ...filter, listId: named };
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length === 0 || tags.some((t) => typeof t !== "string" || t === "")) {
      throw new Error('filterJson.tags must be a non-empty array of tag names, like ["hot"]');
    }
  }
  return filter;
}

/** What a stored or incoming `filterJson` is: the judged filter, or the sentence refusing it. */
export interface ExportFilterRead {
  /** The filter as this module judges it — an id with its padding stripped. Empty when nothing was said. */
  filter: Record<string, unknown>;
  /** Why the blob is not an export filter, or `null` when it is one. */
  problem: string | null;
}

/**
 * `readExportFilter` for a door that has to keep what it judged.
 *
 * The export row is the durable artefact — `GET /api/exports` echoes its
 * `filterJson`, and a retry re-queues the config the door wrote — so the value the
 * file is built from and the value the row shows have to be the same bytes. Reading
 * through `readExportFilter` and storing its answer is how `POST /api/lead-lists`
 * already treats a dynamic list's filter (`asInputJson(declared.filter)` rather
 * than the blob it was handed), and it means the worker's re-read of the stored row
 * cannot find a different filter than the door resolved.
 */
export function exportFilter(raw: unknown): ExportFilterRead {
  try {
    return { filter: readExportFilter(raw), problem: null };
  } catch (error) {
    return { filter: {}, problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The same question, as only the sentence — `null` when the filter is sound. For a
 * caller that judges the blob and then throws it away; a door that stores it reads
 * through `exportFilter` so the stored bytes are the judged ones.
 */
export function exportFilterProblem(raw: unknown): string | null {
  return exportFilter(raw).problem;
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
