import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stringify } from "csv-stringify/sync";
import * as XLSX from "xlsx";
import { csvSafeText } from "../../src/lib/export-format";
import { EXPORT_CREATE, LEAD_EXPORT_FIELDS } from "../../src/lib/fields";
import { openapiOperations } from "../../src/lib/openapi";
import { blankComments, functionBody } from "./route-handlers";

// #69: an export's declared columns disappear exactly when the crowd is empty.
// Measured on this round's base build (`88bf6d2`) in its own runtime — `:3421` over
// `leadworks_r70`, three leads (ana NEW, bo NEW, cy ENRICHED), one list with no members,
// every leg declaring `fields: ["email","status","company"]` — logs
// `/tmp/opencode/r70_press_base2.log` (the workbook's own XML, the PDF's text, the
// `fields` refusals) and the `--- BASE :3421 ---` block of `r71_press_ab.log`, bytes read
// off the download each leg fetched after its row reached `COMPLETED`:
//
//   {"status":"NEW"}         CSV  recordCount=2 fileSize=58   "email,status,company\n" plus two rows
//   {"status":"CONVERTED"}   CSV  recordCount=0 fileSize=0    download 200, zero bytes
//   {"listId":"<no-member>"} CSV  recordCount=0 fileSize=0    download 200, zero bytes
//   {"tags":["nosuch"]}      CSV  recordCount=0 fileSize=0    download 200, zero bytes
//   {"status":"CONVERTED"}   JSON recordCount=0 fileSize=2    "[]"
//   {"status":"CONVERTED"}   XLSX recordCount=0 fileSize=15767  "<sheetData/>", dimension A1
//   {"status":"CONVERTED"}   PDF  recordCount=0 fileSize=1640  "0 leads · fields: email, status, company"
//
// (The PDF's length moves by a byte between runs because the generated-at text is in it; the
// two empty-CSV/XLSX/JSON legs above were each measured three ways — by status, by an
// unreachable list, by an unheld tag — and gave the same bytes all three times.)
//
// One crowd, four files, and the two a spreadsheet opens are silent about what they were
// asked to hold — the CSV has no bytes at all, the workbook has a sheet with no cells —
// while JSON answers `[]` and the PDF prints the count and the columns. And `fields` is
// *required* at the door (`400 fields is required`), so the app never lacks the names.
// The rule this borrows is the app's own, two modules away: `import-problems.ts:16`
// returns `[header, ...rows].join("\n") + "\n"`, so an import with nothing wrong with it
// still arrives with `"line","field","message"` on its first line. A reject list is a
// header plus zero rows; so is an export nobody matched, and only one of the two said so.
const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const exporterSource = at("../../src/lib/exporter.ts");
// Both writers are scanned with their comments blanked: this round's own fix comment
// quotes the words `json_to_sheet` builds its header from, and a pin that can be
// satisfied by the prose explaining it is not a pin.
const exporter = blankComments(exporterSource);
const csvBody = functionBody(exporter, "exportToCSV")!;
const xlsxBody = functionBody(exporter, "exportToXLSX")!;
const FIELDS = ["email", "status", "company"];

/** The bytes an empty crowd produces today, in the same call the writer makes. */
const csvToday = (rows: Record<string, string>[]) => stringify(rows, { header: true });

describe("the header a caller declared is not a favour the rows have to earn", () => {
  it("reproduces the measured 0 bytes before fixing them", () => {
    // The base build's `fileSize=0` is not a Prisma or filesystem artifact: it is one
    // call, offline, with no rows. Pinning the broken output is what makes the fix's
    // difference a fact about this line rather than a story about the runtime.
    assert.equal(csvToday([]), "");
    assert.equal(csvToday([{ email: "bo@x.com", status: "NEW", company: "Acme" }]), "email,status,company\nbo@x.com,NEW,Acme\n");
  });

  it("names the columns csv-stringify would have written", () => {
    assert.equal(stringify([], { header: true, columns: FIELDS }), "email,status,company\n");
  });

  it("leaves a non-empty file byte-identical", () => {
    // The whole change has to be invisible when there are rows, because the rows are the
    // product: same order, same quoting, same cells.
    const rows = FIELDS.reduce<Record<string, string>>((row, field) => ({ ...row, [field]: csvSafeText(field === "email" ? "bo@x.com" : "Acme") }), {});
    assert.equal(stringify([rows], { header: true, columns: FIELDS }), stringify([rows], { header: true }));
  });

  it("keeps the order the caller spelled, not the order the rows happened to have", () => {
    const row = { company: "Acme", email: "bo@x.com", status: "NEW" };
    assert.equal(stringify([row], { header: true, columns: FIELDS }).split("\n")[0], "email,status,company");
  });

  it("survives a field no row carries, because the columns are the contract", () => {
    // `getNestedValue` answers `undefined` for a path the lead does not have, so today's
    // header is built from whatever keys survived; with `columns` an absent value still
    // gets its column. This is the same fact the empty crowd teaches, at row scale.
    assert.equal(stringify([{ email: "bo@x.com" }], { header: true, columns: FIELDS }).split("\n")[0], "email,status,company");
  });
});

describe("the workbook gets the same rule, and says it in cells a spreadsheet reads", () => {
  it("reproduces the measured empty sheet", () => {
    const ws = XLSX.utils.json_to_sheet([]);
    assert.equal(ws["!ref"], "A1");
    assert.deepEqual(Object.keys(ws), ["!ref"], "no cell at all — the file is 15 KB of container around an empty sheetData");
    assert.deepEqual(XLSX.utils.sheet_to_json(ws, { header: 1 }), [[]], "what a spreadsheet reads back is one empty row, not a header");
  });

  it("writes the declared columns as a header row when there is no data", () => {
    const ws = XLSX.utils.aoa_to_sheet([FIELDS]);
    assert.deepEqual(XLSX.utils.sheet_to_json(ws, { header: 1 }), [FIELDS]);
    assert.equal(ws["A1"].t, "s");
    assert.equal(ws["!ref"], "A1:C1");
  });

  it("round-trips through the writer's own bytes", () => {
    // `exportToXLSX` cannot use SheetJS's `writeFile` in this build (see its comment), so
    // the check is that the bytes this function writes still open as the sheet it claims.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([FIELDS]), "Leads");
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const back = XLSX.read(Buffer.from(bytes), { type: "array" });
    assert.deepEqual(XLSX.utils.sheet_to_json(back.Sheets["Leads"]!, { header: 1 }), [FIELDS]);
  });

  it("does not touch a sheet that has rows", () => {
    const data = [{ email: "bo@x.com", status: "NEW", company: "Acme" }];
    const withBranch = data.length === 0 ? XLSX.utils.aoa_to_sheet([FIELDS]) : XLSX.utils.json_to_sheet(data);
    const plain = XLSX.utils.json_to_sheet(data);
    assert.deepEqual(withBranch, plain);
  });
});

describe("the two writers in src/lib/exporter.ts carry the rule", () => {
  it("passes the declared columns to csv-stringify", () => {
    assert.match(csvBody, /stringify\(rows, \{ header: true, columns: fields \}\)/);
    assert.doesNotMatch(csvBody, /stringify\(rows, \{ header: true \}\)/, "the header would come from the rows again");
  });

  it("gives the workbook its header row when the crowd is empty", () => {
    assert.match(
      xlsxBody,
      /data\.length === 0 \? XLSX\.utils\.aoa_to_sheet\(\[fields\]\) : XLSX\.utils\.json_to_sheet\(data\)/,
    );
    assert.match(xlsxBody, /XLSX\.utils\.json_to_sheet\(data\)/, "a crowd with rows keeps the writer it has always used");
  });

  it("keeps the cell rules that are not this round's question", () => {
    // `csvSafeText` and `exportCell` are other rounds' fixes; an argument that only adds a
    // header must not quietly re-decide how a dangerous cell is written.
    const bare = blankComments(csvBody);
    assert.match(bare, /row\[field\] = csvSafeText\(getNestedValue\(lead, field\)\)/);
    assert.match(blankComments(xlsxBody), /Array\.isArray\(value\)/);
    assert.match(exporter, /const filePath = `\/tmp\/export_\$\{Date\.now\(\)\}\.csv`/);
  });

  it("leaves the two formats that already answered honestly alone", () => {
    // JSON's `[]` and the PDF's "0 leads · fields: …" are both true statements about an
    // empty crowd. Widening this round to them would be re-deciding a format, not a bug.
    const json = functionBody(exporter, "exportToJSON")!;
    const pdf = functionBody(exporter, "exportToPDF")!;
    assert.match(json, /JSON\.stringify\(data, null, 2\)/);
    assert.match(pdf, /`\$\{leads\.length\} lead\$\{leads\.length === 1 \? "" : "s"\} · fields: \$\{fields\.join\(", "\)\} · generated /);
    assert.match(pdf, /No leads matched this export's filter\./, "and it says the crowd was empty in prose, not by omitting the file");
  });
});

describe("the contract promises the file, not just a file", () => {
  const download = openapiOperations.find((entry) => entry.operation.id === "exports.download")!;

  it("says a CSV carries its declared columns even when nobody matched", () => {
    const responses = download.operation.responses as Record<string, string>;
    assert.match(responses["200"], /names the columns its request declared on its first line even when no lead matched/);
    assert.match(responses["200"], /as the import's problem report does/, "the promise is the rule this app already keeps elsewhere");
    assert.match(responses["200"], /an empty JSON is `\[\]`/, "and it does not pretend the other formats were broken");
  });

  it("leaves the retention refusal the same sentence it was", () => {
    const responses = download.operation.responses as Record<string, string>;
    assert.equal(responses["410"], "The file's retention has passed.");
    assert.equal(download.path, "/api/exports/{id}/download");
  });
});

describe("the rule is the app's own, borrowed from the import report", () => {
  it("writes a header for a problem list with no problems", () => {
    const problems = at("../../src/lib/import-problems.ts");
    const body = blankComments(functionBody(problems, "problemsToCsv")!);
    assert.match(body, /const header = \["line", "field", "message"\]\.map\(cell\)\.join\(","\)/);
    assert.match(body, /return \[header, \.\.\.rows\]\.join\("\\n"\) \+ "\\n"/);
    assert.match(problems, /import \{ csvSafeText \} from "\.\/export-format"/, "and it uses the export's cell rule");
  });

  it("keeps `fields` a question the door already demands an answer to", () => {
    // The fix is unconditional because the column list is never unknown: the create door
    // requires the key and requires at least one name in it, measured as
    // `400 {"error":"fields is required"}`. `values` is why the header can be written
    // straight from these strings — every name in it is a column this app can project.
    assert.equal(EXPORT_CREATE.fields.required, true);
    assert.equal(EXPORT_CREATE.fields.min, 1);
    assert.deepEqual(EXPORT_CREATE.fields.values, [...LEAD_EXPORT_FIELDS]);
  });
});
