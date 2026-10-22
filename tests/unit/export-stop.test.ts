// #43 — the export door answered `ok`, and the worker wrote over the answer twice.
//
// Measured against the running app before this file's subject shipped:
//
//   ?action=cancel on a queued EXPORT job -> 200 {"ok":true}
//   +    97ms  Job[CANCELLED 0 0]   Export[COMPLETED /tmp/export_1792669709914.pdf 19]
//   +   236ms  Job[COMPLETED 19 19] Export[COMPLETED /tmp/export_1792669709914.pdf 19]
//
// #41 named this shape and left it in place on purpose: `lib/exporter.ts` was one of the two
// workers that never consult the mark. #42 made it sharper rather than smaller, because a
// resume can only be taken from a row that *keeps* a status a worker put down, and an Export
// row never keeps one — the stop is erased before either door can be asked again.
//
// An export's indivisible unit is not a lead but the file: one query for the crowd, a render
// in memory, one `writeFile`. So a stop here is "before the bytes" or "after the bytes", and
// the second case has a residue the row-wise workers never produce — bytes on a disk no row
// will ever name. This file pins the two decisions `src/lib/export-stop.ts` owns (what the
// record says, and what happens to the bytes) and the wiring in `src/lib/exporter.ts` that
// makes them the worker's behaviour: the guarded claim, the mark asked at each boundary, the
// disk-then-record-then-job order of the put-down, and the fact that no stopped path ever
// puts `export.completed` on the wire.
//
// Nothing here needs a browser, a database, a disk or a network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import { MARK, isMarked, stoppedWrite } from "../../src/lib/job-stop";
import { retryAsk } from "../../src/lib/job-retry";
import {
  MISSING_EXPORT_FILE_ERROR,
  planRowDelete,
  retiredExportError,
} from "../../src/lib/export-retention";
import { STOPPED_EXPORT_ERROR, stoppedExportBytes, stoppedExportWrite } from "../../src/lib/export-stop";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The module's own code, prose blanked: what it can do is what is left. */
const stopCode = blankComments(at("../../src/lib/export-stop.ts"));
const stopRaw = at("../../src/lib/export-stop.ts");
/** The worker's code, prose blanked. */
const exporterCode = blankComments(at("../../src/lib/exporter.ts"));
const exporterRaw = at("../../src/lib/exporter.ts");
const detailRoute = blankComments(at("../../src/app/api/exports/[id]/route.ts"));
const schema = at("../../prisma/schema.prisma");

const runBody = functionBody(exporterCode, "runExportJob") ?? "";
const putDownBody = functionBody(exporterCode, "putDownStopped") ?? "";

/** Every `/tmp/export_<digits>.<ext>` the four format branches can produce. */
const ARTIFACTS = ["csv", "json", "xlsx", "pdf"].map((ext) => `/tmp/export_1792669709914.${ext}`);

/** Paths no writer of this application's can build, each of which would be a wrong file to remove. */
const NOT_ARTIFACTS = [
  "/tmp/export_1792669709914.txt",
  "/tmp/export_.csv",
  "/tmp/export_1792669709914.csv.tmp",
  "/tmp/leads_1792669709914.csv",
  "/home/app/export_1792669709914.csv",
  "/tmp/export_1792669709914.csv/../../etc/passwd",
  "export_1792669709914.csv",
  "/tmp//export_1792669709914.csv",
];

describe("what a stopped export's record says", () => {
  it("carries exactly the seven facts the row is written with", () => {
    assert.deepEqual(Object.keys(stoppedExportWrite()).sort(), [
      "completedAt",
      "error",
      "expiresAt",
      "filePath",
      "fileSize",
      "recordCount",
      "status",
    ]);
  });

  it("picks `FAILED` from the four words this column documents, and invents no fifth", () => {
    assert.equal(stoppedExportWrite().status, "FAILED");
    const start = schema.indexOf("model Export {");
    const exportModel = schema.slice(start, schema.indexOf("\nmodel ", start));
    const line = exportModel.split("\n").find((row) => /^\s+status\s+String\s+@default\("PENDING"\)/.test(row)) ?? "";
    assert.match(line, /\/\/ PENDING \| PROCESSING \| COMPLETED \| FAILED/, "the documented set is four words");
    assert.doesNotMatch(line, /STOPPED|CANCELLED/, "#43 did not add a word to the schema");
  });

  it("writes every fact about a file as nothing, not as absent", () => {
    const write = stoppedExportWrite();
    for (const column of ["filePath", "fileSize", "expiresAt", "completedAt"] as const) {
      assert.ok(column in write, `${column} is a key, so the update clears it rather than leaving it`);
      assert.equal(write[column], null, `${column} is null, not undefined and not a stale value`);
    }
  });

  it("claims no rows reached", () => {
    assert.equal(stoppedExportWrite().recordCount, 0);
  });

  it("quotes the operator as the reason, and points at the door that starts it again", () => {
    const error = stoppedExportWrite().error;
    assert.equal(error, STOPPED_EXPORT_ERROR);
    assert.match(error, /cancelled by the operator/);
    assert.match(error, /before the file was written/);
    assert.match(error, /retry the export/);
  });

  it("answers the same both times without sharing an object", () => {
    const a = stoppedExportWrite();
    const b = stoppedExportWrite();
    assert.deepEqual(a, b);
    a.recordCount = 99;
    assert.equal(b.recordCount, 0);
  });
});

describe("three sentences about a file, kept three facts apart", () => {
  it("is not the expiry sentence and not the missing-file sentence", () => {
    const retired = retiredExportError(new Date("2026-10-20T00:00:00.000Z"));
    const distinct = [STOPPED_EXPORT_ERROR, retired, MISSING_EXPORT_FILE_ERROR];
    assert.equal(new Set(distinct).size, 3);
    assert.doesNotMatch(STOPPED_EXPORT_ERROR, /retired|expired|missing|not there|lost/);
    assert.match(retired, /retired on 2026-10-20T00:00:00\.000Z/);
    assert.match(MISSING_EXPORT_FILE_ERROR, /expired from this server/);
  });

  it("names no path, no size and no date, because a stopped export has none of the three", () => {
    assert.doesNotMatch(STOPPED_EXPORT_ERROR, /\/tmp|bytes|\d/);
  });
});

describe("what happens to bytes a stopped run already wrote", () => {
  it("takes back each shape this application's writers can produce", () => {
    for (const path of ARTIFACTS) {
      assert.deepEqual(stoppedExportBytes(path), { action: "unlink", filePath: path });
    }
  });

  it("says `no file` for a run that stopped before the path existed", () => {
    for (const path of [null, undefined, ""]) {
      assert.deepEqual(stoppedExportBytes(path), { action: "none", reason: "no file" });
    }
  });

  it("leaves every path it cannot prove it wrote exactly where it is", () => {
    for (const path of NOT_ARTIFACTS) {
      assert.deepEqual(stoppedExportBytes(path), { action: "none", reason: "path is not an export artifact" });
    }
  });

  it("is the same rule the delete door asks, not a second copy of it", () => {
    for (const path of [...ARTIFACTS, ...NOT_ARTIFACTS, null, undefined, ""]) {
      assert.deepEqual(stoppedExportBytes(path), planRowDelete(path));
    }
    const body = functionBody(stopCode, "stoppedExportBytes") ?? "";
    assert.match(body, /return planRowDelete\(filePath\);/, "one delegation");
    assert.doesNotMatch(body, /\/tmp|export_/, "and no shape of its own to drift");
  });
});

describe("the module holds no disk, no database and no clock", () => {
  it("imports one thing: the guard it delegates to", () => {
    const imports = stopRaw.split("\n").filter((line) => /^import\b/.test(line));
    assert.equal(imports.length, 1);
    assert.match(imports[0], /from "\.\/export-retention"/);
  });

  it("has no `fs`, no `prisma`, no `unlink`, no `await` and no date of its own", () => {
    for (const needle of ["node:fs", "fs/promises", "prisma", "unlink", "await", "new Date(", "process.env"]) {
      assert.ok(!stopCode.includes(needle), `export-stop.ts must not contain ${needle}`);
    }
  });

  it("owns the sentence once, and the worker does not re-spell it", () => {
    assert.equal((stopCode.match(/cancelled by the operator/g) ?? []).length, 1);
    assert.ok(!exporterRaw.includes("cancelled by the operator"), "the put-down site asks the module");
    assert.equal((exporterCode.match(/data: stoppedExportWrite\(\)/g) ?? []).length, 1);
  });
});

describe("the worker obeys the mark at four boundaries", () => {
  it("claims the job around the mark before it touches the export row", () => {
    const claim = runBody.indexOf('where: { id: jobId, status: { not: MARK } }');
    assert.ok(claim >= 0, "a guarded claim exists");
    assert.ok(claim < runBody.indexOf('status: "PROCESSING"'), "the claim is the first write");
    assert.match(runBody, /data: startWrite\(new Date\(\)\)/, "and it opens the run the way the other workers do");
  });

  it("puts the record down and leaves when the claim finds the mark already there", () => {
    assert.match(runBody, /if \(!began\.count\) \{[\s\S]{0,120}?putDownStopped\(job\.id, exportRecord\.id, 0, null\);\s*\n\s*return;/, "a refused claim is a stop, not a start");
    assert.ok(runBody.indexOf("if (!began.count)") < runBody.indexOf("getLeadsForExport"), "before the crowd is read");
  });

  it("asks before the bytes, after the crowd", () => {
    const asks = [...runBody.matchAll(/isMarked\(await prisma\.job\.findUnique/g)].map((m) => m.index);
    assert.equal(asks.length, 3, "before, after and in the error path");
    assert.ok(runBody.indexOf("getLeadsForExport(job.workspaceId") < asks[0], "the denominator is known when it asks");
    assert.ok(asks[0] < runBody.indexOf("switch (config.format)"), "and the file is not built after a stop");
  });

  it("asks again once the bytes exist and before any row names them", () => {
    assert.ok(runBody.indexOf("writtenFile = filePath") < runBody.indexOf("isMarked(await prisma.job.findUnique", runBody.indexOf("switch (config.format)")));
    const second = [...runBody.matchAll(/isMarked\(await prisma\.job\.findUnique/g)][1]?.index ?? -1;
    assert.ok(second > runBody.indexOf("fs.stat(filePath)"), "asked with the file on disk");
    assert.ok(second < runBody.indexOf('status: "COMPLETED"'), "and before the record is stamped for it");
  });

  it("keeps the finished export's lifetime the one stamp it always was", () => {
    assert.equal((exporterCode.match(/expiresAt/g) ?? []).length, 1, "one expiry write in the whole worker");
    assert.match(exporterCode, /expiresAt: expiryFor\(finishedAt\)/);
    assert.ok(!putDownBody.includes("expiryFor"), "a stopped run sets no lifetime");
  });

  it("finishes around the mark, and does not announce a stopped run", () => {
    assert.equal((runBody.match(/dispatchWebhookEvent\(/g) ?? []).length, 1, "one announcement, on the completed path");
    const dispatch = runBody.indexOf("await dispatchWebhookEvent(");
    assert.ok(dispatch > runBody.indexOf("if (!finish.count)"), "guarded after the finish's own `count`");
    assert.match(runBody, /if \(!finish\.count\) \{[\s\S]{0,140}?putDownStopped\(job\.id, exportRecord\.id, leads\.length, writtenFile\);\s*\n\s*return;\s*\n\s*\}/);
    const inTry = runBody.slice(0, runBody.indexOf("} catch (error) {"));
    assert.equal((inTry.match(/putDownStopped\(/g) ?? []).length, 4, "claim, before the bytes, after them, lost finish");
    for (const site of [...inTry.matchAll(/putDownStopped\(/g)]) {
      assert.ok(site.index < dispatch, "no stopped path inside the try reaches the wire");
    }
    assert.doesNotMatch(
      runBody.slice(dispatch, runBody.indexOf("} catch (error) {")),
      /prisma\.|if \(/,
      "the announcement is the try's last statement, so a throw after it cannot follow a delivery",
    );
    assert.match(runBody, /where: \{ id: job\.id, status: \{ not: MARK \} \}/, "the finish is a guarded write");
  });

  it("lets the operator's word outrank its own error", () => {
    const catchAt = runBody.indexOf("} catch (error) {");
    const third = [...runBody.matchAll(/isMarked\(await prisma\.job\.findUnique/g)][2]?.index ?? -1;
    assert.ok(third > catchAt, "the error path asks the mark first");
    assert.ok(third < runBody.indexOf('data: { status: "FAILED", error: errorMessage }'), "and does not overwrite it with its own failure");
    assert.match(runBody, /putDownStopped\(job\.id, exportRecord\.id, 0, writtenFile\)/, "keeping any bytes the throw left behind");
  });

  it("asks the mark exactly three times and never reads a lookalike as one", () => {
    assert.equal((exporterCode.match(/isMarked\(/g) ?? []).length, 3);
    assert.equal(isMarked({ status: "FAILED" }), false, "a stopped-then-broken row is not a mark");
    assert.equal(isMarked({ status: MARK }), true);
    assert.equal(isMarked(null), false);
  });
});

describe("putting both rows down, and the disk first", () => {
  it("removes the file, then the record, then the job", () => {
    const unlink = putDownBody.indexOf("fs.unlink(bytes.filePath)");
    const record = putDownBody.indexOf("prisma.export.update");
    const job = putDownBody.indexOf("prisma.job.updateMany");
    assert.ok(unlink >= 0 && unlink < record && record < job, "disk → record → job");
    assert.equal((putDownBody.match(/\bunlink\(/g) ?? []).length, 1, "one statement, guarded by the plan");
    assert.match(putDownBody, /const bytes = stoppedExportBytes\(filePath\)/);
    assert.match(putDownBody, /if \(bytes\.action === "unlink"\)/);
  });

  it("reports a file it could not remove instead of throwing over it", () => {
    assert.match(putDownBody, /catch \(error\)/);
    assert.match(putDownBody, /stopped run's file left on disk/);
    assert.match(putDownBody, /bytes a stopped run wrote were left alone — \$\{bytes\.reason\}/, "and says why one was left alone");
  });

  it("writes the record through the module, not by hand", () => {
    assert.match(putDownBody, /data: stoppedExportWrite\(\)/);
    assert.doesNotMatch(putDownBody, /expiresAt|filePath: null/, "no second copy of the null-out");
  });

  it("puts the job down under its own mark and never walks a status back", () => {
    assert.match(putDownBody, /where: \{ id: jobId, status: MARK \}/);
    assert.match(putDownBody, /data: stoppedWrite\(\{ total, processed: 0, failed: 0 \}, new Date\(\)\)/);
    assert.equal(stoppedWrite({ total: 19, processed: 0, failed: 0 }, new Date("2026-10-22T00:00:00.000Z")).status, MARK);
  });

  it("is asked from every one of the five stop sites", () => {
    assert.equal((runBody.match(/putDownStopped\(/g) ?? []).length, 5, "claim, before the bytes, after them, lost finish, error path");
    assert.equal((exporterCode.match(/async function putDownStopped\(/g) ?? []).length, 1);
  });
});

describe("a stopped export is resumable from the moment it stops", () => {
  it("lands on the word the export door already accepts", () => {
    assert.match(detailRoute, /if \(exportRecord\.status !== "FAILED"\)/, "that door refuses anything but FAILED");
    assert.equal(stoppedExportWrite().status, "FAILED");
    assert.match(detailRoute, /Can only retry failed exports/);
  });

  it("leaves the job row in the state #42's door can take a resume from", () => {
    assert.equal(stoppedWrite({ total: 0, processed: 0, failed: 0 }, new Date()).status, MARK);
    assert.equal(retryAsk(MARK).ok, true, "the Job row keeps the mark, so the Job door can resume it");
    assert.equal(retryAsk("FAILED").ok, true, "and the Export row's word is terminal for this door too");
  });

  it("does not touch the other three workers or the retry door", () => {
    for (const file of ["src/lib/dedupe.ts", "src/lib/enrichment.ts", "src/lib/validator.ts"]) {
      assert.ok(at(`../../${file}`).includes("job-stop"), `${file} still owns its own stop`);
    }
    assert.ok(!exporterCode.includes("retryRow"), "the worker resumes nothing; doors do");
  });
});
