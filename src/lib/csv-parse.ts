import { parse } from "csv-parse/sync";
import { LEAD_CREATE } from "./fields";
import { collectBody } from "./validation-engine";
import { MAX_IMPORT_ROWS } from "./import-limits";

/**
 * The pure half of CSV import: quoting, header aliases, line numbers, in-file
 * duplicates and per-row validation. No database, no webhooks — so the rules
 * that decide what a row means can be tested without a server, and the write in
 * `csv-import.ts` cannot quietly disagree with them.
 *
 * A lead tool that cannot take the list the buyer already has is a tool they
 * evaluate and leave. The landing page has always said "CSV uploads"; until now
 * only the exporter existed.
 */

export { MAX_IMPORT_ROWS, MAX_REPORTED_PROBLEMS } from "./import-limits";

export type ImportProblem = { line: number; field: string; message: string };

export type LeadImportFields = {
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  department?: string;
  seniority?: string;
  location?: string;
  country?: string;
  industry?: string;
  companySize?: string;
  revenue?: string;
  technologies?: string[];
  intentSignals?: string[];
  tags?: string[];
};

export type ParsedLeadRow = {
  line: number;
  data: LeadImportFields;
  key: string;
  email: string | null;
};

export type ParsedLeadCsv = {
  rows: ParsedLeadRow[];
  problems: ImportProblem[];
  duplicatesInFile: Array<{ line: number; firstLine: number; key: string }>;
  total: number;
  invalidRows: number;
  parseError?: { line: number | null; message: string };
};

/**
 * Header aliases, normalized to lowercase words with `_`/`-` read as spaces.
 * The product is sold to people exporting from HubSpot, Apollo, LinkedIn and
 * Excel, not to people who rename their columns first.
 */
const HEADER_ALIASES: Record<string, string> = {
  email: "email",
  "e mail": "email",
  "email address": "email",
  "work email": "email",
  emailaddress: "email",
  phone: "phone",
  "phone number": "phone",
  telephone: "phone",
  tel: "phone",
  mobile: "phone",
  linkedin: "linkedinUrl",
  "linkedin url": "linkedinUrl",
  "linkedin profile": "linkedinUrl",
  linkedinurl: "linkedinUrl",
  "first name": "firstName",
  firstname: "firstName",
  "given name": "firstName",
  "last name": "lastName",
  lastname: "lastName",
  surname: "lastName",
  "family name": "lastName",
  company: "company",
  "company name": "company",
  organization: "company",
  organisation: "company",
  title: "title",
  "job title": "title",
  role: "title",
  position: "title",
  department: "department",
  seniority: "seniority",
  location: "location",
  city: "location",
  country: "country",
  industry: "industry",
  "company size": "companySize",
  companysize: "companySize",
  employees: "companySize",
  revenue: "revenue",
  "annual revenue": "revenue",
  tags: "tags",
  technologies: "technologies",
  tech: "technologies",
  "intent signals": "intentSignals",
  intentsignals: "intentSignals",
};

const TEXT_FIELDS = [
  "firstName",
  "lastName",
  "company",
  "title",
  "department",
  "location",
  "country",
  "industry",
  "companySize",
  "revenue",
] as const;

const LIST_FIELDS = ["technologies", "intentSignals", "tags"] as const;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Pick one delimiter from the header line, outside quotes. Passing all three to
 * csv-parse is not a choice — it treats each as a delimiter everywhere, so a
 * comma CSV with `vip;beta` in a tags cell splits into a fourth column.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

/**
 * Map the header row to schema names. Duplicate names are suffixed rather than
 * allowed to overwrite each other: a sheet with two "Email" columns should not
 * silently keep only the last one.
 */
function mapColumns(header: string[]): string[] {
  const seen = new Set<string>();
  return header.map((raw) => {
    const base = normalizeHeader(raw);
    let key = HEADER_ALIASES[base] ?? base;
    if (!key) key = "column";
    if (seen.has(key)) {
      let n = 2;
      while (seen.has(`${key}_${n}`)) n += 1;
      key = `${key}_${n}`;
    }
    seen.add(key);
    return key;
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): string[] | undefined {
  const v = text(value);
  if (!v) return undefined;
  const items = v
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  return text(value)?.toLowerCase();
}

/** Keep a leading `+`; drop the punctuation a spreadsheet adds to phone cells. */
function normalizePhone(value: unknown): string | undefined {
  const v = text(value);
  if (!v) return undefined;
  const plus = v.startsWith("+") ? "+" : "";
  const digits = v.replace(/\D/g, "");
  return digits ? `${plus}${digits}` : v;
}

/** A cell that says `linkedin.com/in/x` is a URL; the API's validator wants a scheme. */
function normalizeLinkedIn(value: unknown): string | undefined {
  const v = text(value);
  if (!v) return undefined;
  return /^(www\.)?linkedin\.com\//i.test(v) ? `https://${v}` : v;
}

function mapRow(record: Record<string, unknown>): LeadImportFields {
  const out: LeadImportFields = {};
  const email = normalizeEmail(record.email);
  if (email) out.email = email;
  const phone = normalizePhone(record.phone);
  if (phone) out.phone = phone;
  const linkedinUrl = normalizeLinkedIn(record.linkedinUrl);
  if (linkedinUrl) out.linkedinUrl = linkedinUrl;
  for (const key of TEXT_FIELDS) {
    const v = text(record[key]);
    if (v) out[key] = v;
  }
  const seniority = text(record.seniority);
  if (seniority) out.seniority = seniority.toUpperCase().replace(/[\s-]+/g, "_");
  for (const key of LIST_FIELDS) {
    const v = list(record[key]);
    if (v) out[key] = v;
  }
  return out;
}

function dedupeKey(data: LeadImportFields): string | null {
  if (data.email) return `email:${data.email}`;
  if (data.phone) return `phone:${data.phone}`;
  if (data.linkedinUrl) return `linkedin:${data.linkedinUrl.toLowerCase()}`;
  return null;
}

/**
 * Parse and validate a CSV without touching the database.
 *
 * `info.lines` is used rather than the array index so a quoted field containing
 * a newline (a company address, usually) does not shift every later error onto
 * the wrong line.
 */
export function parseLeadCsv(text: string): ParsedLeadCsv {
  const empty: ParsedLeadCsv = {
    rows: [],
    problems: [],
    duplicatesInFile: [],
    total: 0,
    invalidRows: 0,
  };
  if (!text.trim()) {
    return { ...empty, parseError: { line: null, message: "the file is empty" } };
  }

  let headers: string[] = [];
  let records: Array<{ record: Record<string, unknown>; info: { lines: number } }>;
  try {
    records = parse(text, {
      bom: true,
      // Excel in a comma-decimal locale writes semicolons; tab-separated exports
      // are common too. Detect one from the header rather than treating all
      // three as delimiters.
      delimiter: detectDelimiter(text),
      columns: (header: string[]) => {
        headers = mapColumns(header);
        return headers;
      },
      info: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
      relax_quotes: false,
    }) as Array<{ record: Record<string, unknown>; info: { lines: number } }>;
  } catch (error) {
    const e = error as { message?: string; lines?: number };
    return {
      ...empty,
      parseError: {
        line: typeof e.lines === "number" ? e.lines : null,
        message: e.message ?? "could not parse the CSV",
      },
    };
  }

  if (!headers.some((h) => h === "email" || h === "phone" || h === "linkedinUrl")) {
    return {
      ...empty,
      parseError: {
        line: 1,
        message: "the first row must be a header naming an email, phone or LinkedIn column",
      },
    };
  }
  if (records.length > MAX_IMPORT_ROWS) {
    return {
      ...empty,
      parseError: {
        line: null,
        message: `this file has ${records.length} data rows; the limit is ${MAX_IMPORT_ROWS} per import`,
      },
    };
  }
  if (records.length === 0) {
    return { ...empty, parseError: { line: 1, message: "the file has a header but no data rows" } };
  }

  const rows: ParsedLeadRow[] = [];
  const problems: ImportProblem[] = [];
  const duplicatesInFile: Array<{ line: number; firstLine: number; key: string }> = [];
  const seen = new Map<string, number>();
  let invalidRows = 0;
  let total = 0;

  for (const { record, info } of records) {
    const line = typeof info?.lines === "number" ? info.lines : total + 2;
    const data = mapRow(record);
    // A row of commas is not a lead and not an error worth printing.
    if (Object.keys(data).length === 0) continue;
    total += 1;

    const validated = collectBody(data, LEAD_CREATE);
    if (!validated.ok) {
      invalidRows += 1;
      for (const [field, message] of validated.problems) problems.push({ line, field, message });
      continue;
    }
    const clean = validated.data as LeadImportFields;
    if (!clean.email && !clean.phone && !clean.linkedinUrl) {
      invalidRows += 1;
      problems.push({
        line,
        field: "email",
        message: "at least one of email, phone or linkedinUrl is required",
      });
      continue;
    }
    const key = dedupeKey(clean);
    if (!key) {
      invalidRows += 1;
      problems.push({
        line,
        field: "email",
        message: "at least one of email, phone or linkedinUrl is required",
      });
      continue;
    }
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      duplicatesInFile.push({ line, firstLine, key });
      continue;
    }
    seen.set(key, line);
    rows.push({ line, data: clean, key, email: clean.email ?? null });
  }

  return { rows, problems, duplicatesInFile, total, invalidRows };
}
