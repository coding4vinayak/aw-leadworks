// The import rules, pinned without a database. `csv-import.ts` only decides
// what to do with rows that passed; this file is where "passed" is defined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeadCsv, MAX_IMPORT_ROWS } from "../../src/lib/csv-parse";

test("quoted commas, escaped quotes, CRLF and a BOM survive with real line numbers", () => {
  const csv =
    "\uFEFFemail,company,first_name\r\n" +
    '"jane@x.com","Acme, Inc.",Jane\r\n' +
    '"bob@y.com","He said ""hi""",Bob\r\n';
  const r = parseLeadCsv(csv);
  assert.equal(r.parseError, undefined);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].data.company, "Acme, Inc.");
  assert.equal(r.rows[1].data.company, 'He said "hi"');
  assert.equal(r.rows[0].line, 2);
  assert.equal(r.rows[1].line, 3);
  assert.equal(r.total, 2);
});

test("header aliases and casing are understood, not demanded", () => {
  const csv =
    "E-mail,Company_Name,LinkedIn URL,First Name,Last Name\n" +
    "JANE@X.COM,Acme,linkedin.com/in/jane,Jane,Doe\n";
  const r = parseLeadCsv(csv);
  assert.equal(r.rows.length, 1);
  const d = r.rows[0].data;
  assert.equal(d.email, "jane@x.com");
  assert.equal(d.company, "Acme");
  assert.equal(d.linkedinUrl, "https://linkedin.com/in/jane");
  assert.equal(d.firstName, "Jane");
  assert.equal(d.lastName, "Doe");
});

test("semicolon and tab files parse too", () => {
  const semi = parseLeadCsv("email;first name\njane@x.com;Jane\n");
  assert.equal(semi.rows.length, 1);
  assert.equal(semi.rows[0].data.firstName, "Jane");

  const tab = parseLeadCsv("email\tfirst name\njane@x.com\tJane\n");
  assert.equal(tab.rows.length, 1);
  assert.equal(tab.rows[0].data.firstName, "Jane");
});

test("a duplicate inside the file is skipped case-insensitively, with both lines", () => {
  const r = parseLeadCsv("email\nA@X.com\na@x.com\nb@y.com\n");
  assert.equal(r.rows.length, 2);
  assert.equal(r.duplicatesInFile.length, 1);
  assert.equal(r.duplicatesInFile[0].line, 3);
  assert.equal(r.duplicatesInFile[0].firstLine, 2);
  assert.equal(r.total, 3);
});

test("an invalid email is a row problem on its real line", () => {
  const r = parseLeadCsv("email,first name\nnot-an-email,Bad\nok@x.com,Ok\n");
  assert.equal(r.rows.length, 1);
  assert.equal(r.invalidRows, 1);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 2);
  assert.equal(r.problems[0].field, "email");
});

test("a row with no contact method is refused, not silently created", () => {
  const r = parseLeadCsv("email,first name,company\n,Jane,Acme\n");
  assert.equal(r.rows.length, 0);
  assert.equal(r.invalidRows, 1);
  assert.match(r.problems[0].message, /at least one of email, phone or linkedinUrl/);
});

test("blank lines are skipped without shifting the next row's line", () => {
  const r = parseLeadCsv("email\n\njane@x.com\n");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].line, 3);
  assert.equal(r.total, 1);
});

test("tags and technologies accept the separators spreadsheets actually use", () => {
  const r = parseLeadCsv("email,tags,technologies\nx@y.com,vip;beta|2026,React|Node\n");
  assert.deepEqual(r.rows[0].data.tags, ["vip", "beta", "2026"]);
  assert.deepEqual(r.rows[0].data.technologies, ["React", "Node"]);
});

test("phone cells lose their punctuation and keep a real leading plus", () => {
  const r = parseLeadCsv("phone\n+1 (415) 555-0100\n(415) 555-0101\n");
  assert.equal(r.rows[0].data.phone, "+14155550100");
  assert.equal(r.rows[1].data.phone, "4155550101");
});

test("a quoted newline does not move later errors onto the wrong line", () => {
  const csv = 'email,company\njane@x.com,"Acme\nInc"\nbad-email,Bad\n';
  const r = parseLeadCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.invalidRows, 1);
  assert.equal(r.problems[0].line, 4);
});

test("a header with no contact column fails once, with a fixable message", () => {
  const r = parseLeadCsv("first name,company\nJane,Acme\n");
  assert.equal(r.rows.length, 0);
  assert.ok(r.parseError);
  assert.equal(r.parseError.line, 1);
  assert.match(r.parseError.message, /header.*email, phone or LinkedIn/);
});

test("empty and header-only files are distinct errors", () => {
  assert.match(parseLeadCsv("").parseError!.message, /empty/);
  assert.match(parseLeadCsv("email\n").parseError!.message, /no data rows/);
});

test("over the row cap fails loudly with both numbers", () => {
  const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `u${i}@x.com`).join("\n");
  const r = parseLeadCsv(`email\n${rows}\n`);
  assert.ok(r.parseError);
  assert.match(r.parseError.message, new RegExp(String(MAX_IMPORT_ROWS + 1)));
  assert.match(r.parseError.message, new RegExp(String(MAX_IMPORT_ROWS)));
});

test("two Email columns do not overwrite each other — the first wins", () => {
  const r = parseLeadCsv("email,Email\nfirst@x.com,second@x.com\n");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].data.email, "first@x.com");
});

test("unknown columns are ignored, not rejected", () => {
  const r = parseLeadCsv("email,favorite_color\nx@y.com,blue\n");
  assert.equal(r.rows.length, 1);
  assert.equal((r.rows[0].data as Record<string, unknown>).favorite_color, undefined);
});

test("the shared field validator judges the row (invalid seniority is refused)", () => {
  const r = parseLeadCsv("email,seniority\nx@y.com,chief\n");
  assert.equal(r.rows.length, 0);
  assert.equal(r.invalidRows, 1);
  assert.equal(r.problems[0].field, "seniority");
});

test("CR-only line endings still find the header and the rows", () => {
  const r = parseLeadCsv("email,first name\rjane@x.com,Jane\r");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].data.firstName, "Jane");
});

test("a malformed file reports a parse error instead of throwing", () => {
  const r = parseLeadCsv('email,company\n"unclosed,Acme\n');
  assert.ok(r.parseError);
  assert.equal(r.rows.length, 0);
});

test("every data row lands in exactly one bucket", () => {
  const csv =
    "email,first name\n" +
    "a@x.com,A\n" +
    "a@x.com,Duplicate\n" +
    "not-an-email,Bad\n" +
    ",NoContact\n" +
    "b@y.com,B\n";
  const r = parseLeadCsv(csv);
  assert.equal(r.total, 5);
  assert.equal(r.rows.length + r.invalidRows + r.duplicatesInFile.length, r.total);
});
