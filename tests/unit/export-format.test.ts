// What an export is allowed to contain, pinned where the mistakes were made:
// no cell a spreadsheet will execute, no filter quietly widened, no glyph
// silently swapped.
//
// The old exporter was honest-looking in all three places: cells went out raw
// (a lead named `=HYPERLINK(...)` is a live formula in Excel), `filterJson`
// was accepted and ignored (a filtered export shipped the whole workspace),
// and PDFs were a placeholder string with a `application/pdf` content type.
// These tests fail the next time any of those three is true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { csvSafeText, exportCell, pdfSafeText, readExportFilter } from "../../src/lib/export-format";

test("csvSafeText defuses formula leads and leaves numbers alone", () => {
  assert.equal(
    csvSafeText('=HYPERLINK("http://evil.example/x","click")'),
    '\'=HYPERLINK("http://evil.example/x","click")',
  );
  assert.equal(csvSafeText("@SUM(1+1)"), "'@SUM(1+1)");
  assert.equal(csvSafeText("+CMD|' /C calc'!A0"), "'+CMD|' /C calc'!A0");
  assert.equal(csvSafeText("-cmd"), "'-cmd");
  assert.equal(csvSafeText("\t=1+1"), "'\t=1+1");
  assert.equal(csvSafeText(-5), "-5", "a negative number is not a formula");
  assert.equal(csvSafeText("-5"), "-5");
  assert.equal(csvSafeText("12.5"), "12.5");
  assert.equal(csvSafeText("Ada Lovelace"), "Ada Lovelace");
  assert.equal(csvSafeText(null), "");
});

test("exportCell shapes every value one way", () => {
  assert.equal(exportCell(["hot", "emea"]), "hot, emea", "tags read as one cell, not [object Array]");
  assert.equal(exportCell({ tier: "gold" }), '{"tier":"gold"}');
  assert.equal(exportCell(92), "92");
  assert.equal(exportCell(undefined), "");
});

test("a tags cell that begins with a formula character is still defused", () => {
  assert.equal(csvSafeText(["@SUM(1+1)", "hot"]), "'@SUM(1+1), hot");
});

test("readExportFilter refuses anything the exporter cannot honour", () => {
  assert.deepEqual(readExportFilter(undefined), {});
  assert.deepEqual(readExportFilter(null), {});
  assert.deepEqual(readExportFilter({ status: "QUALIFIED" }), { status: "QUALIFIED" });
  assert.deepEqual(readExportFilter({ minScore: 50, tags: ["hot", "emea"] }), {
    minScore: 50,
    tags: ["hot", "emea"],
  });

  assert.throws(
    () => readExportFilter({ temperature: "hot" }),
    /filterJson key "temperature" is not supported — use status, minScore, maxScore, listId, tags/,
    "an unsupported filter is a failed job, not a wider file",
  );
  assert.throws(() => readExportFilter(42), /must be an object/);
  assert.throws(() => readExportFilter({ status: 5 }), /filterJson\.status must be a string/);
  assert.throws(() => readExportFilter({ minScore: 101 }), /whole number from 0 to 100/);
  assert.throws(() => readExportFilter({ minScore: 1.5 }), /whole number from 0 to 100/);
  assert.throws(() => readExportFilter({ tags: [] }), /non-empty array of tag names/);
  assert.throws(() => readExportFilter({ tags: [42] }), /non-empty array of tag names/);
  assert.throws(() => readExportFilter({ listId: 7 }), /filterJson\.listId must be a string/);
});

test("pdfSafeText keeps what the base fonts can draw and makes losses visible", () => {
  assert.equal(pdfSafeText("Zoë Müller-Ødegård"), "Zoë Müller-Ødegård", "Latin-1 survives");
  assert.equal(pdfSafeText("Müller–Ødegård…"), "Müller-Ødegård...");
  assert.equal(pdfSafeText("smart ’quotes’ “here”"), "smart 'quotes' \"here\"");
  assert.equal(pdfSafeText("Zoë 😀"), "Zoë ?", "an undrawable glyph becomes a visible question mark");
  assert.equal(pdfSafeText("line\u0000break\u0007"), "linebreak", "control characters do not reach the page");
});

// exporter.ts pulls the queue module, so it cannot be imported here the way the
// rest of leadworks is tested. Its wiring is pinned by reading the source —
// the failures it guards against only appeared in the build Next ships:
// every XLSX export died "cannot save file …" (SheetJS's ESM writeFile cannot
// reach fs in a bundle) and PDFs were a placeholder string in a .pdf file.
test("the exporter's wiring stays real (what formal tests cannot reach)", () => {
  const src = readFileSync(new URL("../../src/lib/exporter.ts", import.meta.url), "utf8");
  assert.ok(src.includes("XLSX.write("), "XLSX goes through write() — writeFile() cannot reach fs in production");
  assert.ok(!src.includes("XLSX.writeFile("), "writeFile() is the shape that failed every XLSX export in production");
  assert.ok(src.includes("readExportFilter(config.filterJson)"), "an export filter is read, not merely accepted");
  assert.ok(!src.includes('writeFile(filePath, "PDF export placeholder")'), "the PDF placeholder stays dead");
});
