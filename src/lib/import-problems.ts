import { csvSafeText } from "./export-format";
import type { ImportProblem } from "./csv-parse";

/**
 * The error report a buyer takes back to their spreadsheet.
 *
 * A reject list is only useful if it can be opened next to the original file, so
 * the columns are the ones the import response already names: line, field,
 * message. Cells use the export's rule — a header someone named
 * `=HYPERLINK("...")` must stay text when Excel opens the report, not execute.
 */
export function problemsToCsv(problems: ImportProblem[]): string {
  const cell = (value: string | number) => `"${csvSafeText(String(value)).replace(/"/g, '""')}"`;
  const header = ["line", "field", "message"].map(cell).join(",");
  const rows = problems.map((p) => [p.line, p.field, p.message].map(cell).join(","));
  return [header, ...rows].join("\n") + "\n";
}
