// #35 — `Export.expiresAt` is a lifetime, and a lifetime has to be set and read.
//
// Measured against the running app before this round. A CSV export created through
// `POST /api/exports`, polled to `COMPLETED`, downloaded twice:
//
//   * the create door returned `expiresAt: null` and the finished row 1130 ms later
//     returned `expiresAt: null` again, sitting next to a real `completedAt`, a real
//     `filePath` (`/tmp/export_1792570751161.csv`) and a real `fileSize` of 918 bytes —
//     the row named a file of 16 leads' contact details and said nothing about how long
//     that file would answer;
//   * both downloads were `200`, 918 bytes each, and so was a **four-day-old** export
//     from the same table;
//   * `SELECT count(*) … FROM "Export"`: **25 `COMPLETED` rows, 0 with an expiry
//     stamped**, the oldest finished 2026-10-17 04:24;
//   * **every one of the ten `prisma.export.create`/`update` calls in `src/`** (and the
//     one `delete`) passed no `expiresAt`, and none of
//     the 29 `expiresAt` mentions outside `src/generated/` was about `Export` at all —
//     they were Session, InviteToken and the two token tables;
//   * the only place the word "expired" lived was the download door's 410 — *"export file
//     expired from this server — re-run the export"* — which fires when `stat`/`readFile`
//     throws, i.e. when the operating system happened to reclaim `/tmp`. A sentence about
//     expiry with no date behind it anywhere, and nothing in the app ever comparing a row
//     to a clock.
//
// So this round stamps the one write that finishes an export and asks the verdict at both
// doors that hand the file out. What this file pins:
//
//   1. the column and the numbers — the schema, the default, the env key, and the fact
//      that a caller still cannot name the lifetime of a file the server writes;
//   2. `parseRetentionMs` / `retentionMs` — a mistyped policy falls back instead of
//      becoming `NaN` in a `Date`;
//   3. `expiryFor` / `retentionVerdict` — the arithmetic, the inclusive boundary, and the
//      third verdict `null` gets;
//   4. the two 410 sentences staying two sentences;
//   5. the wiring, scanned from the source — one stamp site, both doors asking before the
//      bytes are opened, and the round's own limit (nothing deletes the file yet) checked
//      rather than just asserted in prose.
//
// #36 — the same round, measured again a few hours later, with the doors already shut.
//
//   * **27 `COMPLETED` rows, 2 stamped, both past their date — and both files still on
//     disk, byte-exact**: `/tmp/export_1792571592233.csv` at 4,195 bytes and
//     `/tmp/export_1792571761063.csv` at 957, each row still `COMPLETED`, still naming it,
//     still answering 410;
//   * **51 files matching `/tmp/export_*` against 27 rows**, i.e. 24 files named by no row
//     (this round called `DELETE /api/exports/{id}` their source; #37 measured that and was
//     wrong — see the block below). Oldest on disk: 2026-10-17, four days, 1,528 bytes;
//   * **0 rows whose file was missing**, so the missing-file 410 had never fired here; and
//   * `grep` over `src/`: four sites write a `/tmp/export_<millis>.<ext>` and **zero delete
//     anything** — the application had never removed a file it created.
//
// So this file also pins the purge: `planPurge`'s four reasons and the order they are asked
// in, the shape guard proven against the paths the writers actually build, and the sweep's
// source read for the invariants that make the deletion safe — one `unlink` in `src/`, after
// the plan, on the plan's own `filePath`, with the row left intact.
//
// #37 — the same 24 files, measured rather than explained.
//
//   * **60 `Job` rows of type `EXPORT` against 29 `Export` rows**, and **all 31 jobs naming an
//     `exportId` with no row were created inside one hour** — 2026-10-17 07:00 — **24 of them
//     `COMPLETED`**, the same 24, in the same five minutes (07:40-07:45) the orphan mtimes fill.
//     The demo never calls `DELETE` on an export and its first export code was committed ~3 h
//     after that window; no test calls the four writers; **three sampled orphans have
//     `atime == mtime`**, so nobody ever downloaded them either. So the residue is job history
//     from a table emptied in an hour, not DELETE fallout, and DELETE's measured contribution is
//     zero rows *here* — which is a fact about this data, not a defence of the code.
//   * 29 rows, 29 distinct `filePath`s, **0 empty**; 49 artifacts on disk, 25 named and present,
//     4 named and purged by #36, **24 named by nothing — 65,996 bytes, every one of them a shape
//     the guard accepts**;
//   * the gap between the millisecond in a filename and its row's `completedAt` is
//     **2.3-16.1 ms** across the 25 live rows: the path exists before the row that names it does,
//     which is the reason a census may count unclaimed files and a sweep must not delete them.
//
// So this file also pins the delete door — row first, then the same guard, then an honest word
// about the bytes — and the census: its grace window, the files it declines to see at all, and
// the fact that it reaches a log and not an API.
//
// The live proofs are `demo/run-demo.sh leadworks` STEP 16 (the door), STEP 17 (the bytes the
// sweep takes) and STEP 18 (the bytes the row takes, and the census); everything here is
// reachable without a database, so none of these tests asks for one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { EXPORT_CREATE } from "../../src/lib/fields";
import { validateBody } from "../../src/lib/validate";
import {
  DEFAULT_RETENTION_MS,
  MISSING_EXPORT_FILE_ERROR,
  RETENTION_ENV,
  artifactStamp,
  censusLog,
  expiryFor,
  IN_FLIGHT_GRACE_MS,
  isExportArtifact,
  planRowDelete,
  parseRetentionMs,
  planPurge,
  purgedExportLog,
  retentionMs,
  retentionVerdict,
  retiredExportError,
  unclaimedExportFiles,
} from "../../src/lib/export-retention";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const exporter = at("../../src/lib/exporter.ts");
const streamDoor = at("../../src/app/api/exports/[id]/download/route.ts");
const detailDoor = at("../../src/app/api/exports/[id]/route.ts");
const listDoor = at("../../src/app/api/exports/route.ts");
const retentionModule = at("../../src/lib/export-retention.ts");
const schedulerSource = at("../../src/lib/scheduler.ts");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Call bodies, not line slices: splitting on `prisma.export.update(` hands back
// everything to the end of the file, so an earlier write would be credited with what a
// later one passed. The parens are counted instead.
const callBodies = (src: string, method: "create" | "update" | "updateMany"): string[] => {
  const code = blankComments(src);
  const needle = `prisma.export.${method}(`;
  const bodies: string[] = [];
  for (let i = code.indexOf(needle); i >= 0; i = code.indexOf(needle, i + needle.length)) {
    const open = i + needle.length - 1;
    let depth = 0;
    let end = open;
    for (let k = open; k < code.length; k++) {
      const c = code[k];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    bodies.push(code.slice(open + 1, end));
  }
  return bodies;
};
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });
const src = new URL("../../src", import.meta.url).pathname;
const everyWrite = srcFiles(src).flatMap((file) =>
  (["create", "update", "updateMany"] as const).flatMap((method) =>
    callBodies(readFileSync(file, "utf8"), method).map((body) => ({ file, body })),
  ),
);

/** The row this round is about, as the doors see it: a finished export, one clock. */
const FINISHED = new Date("2026-10-21T08:19:11.163Z");

// Lifted out of the worker's own source, not typed by hand: a guard that was written against a
// remembered shape is a guess. These are the four template literals that `src/lib/exporter.ts`
// builds its paths from, with a real `Date.now()` in place of the interpolation.
const written = [...blankComments(exporter).matchAll(/`(\/tmp\/export_)\$\{Date\.now\(\)\}\.(csv|json|xlsx|pdf)`/g)]
  .map((m) => `${m[1]}1792571592233.${m[2]}`);

// What a `filePath` column could hold that this application did not write. Both guards are
// proven against this list: #36's sweep and #37's delete door answer the same question.
const notArtifacts: readonly unknown[] = [
  "/tmp/export_1792571592233.txt",       // an extension no writer builds
  "/tmp/export_1792571592233.csv/",      // a directory
  "/tmp/export_.csv",                    // no millis
  "/tmp/export_17a9.csv",                // a millis field that is not digits
  "/tmp/export_-1.csv",                  // signed
  "/tmp/export_1792571592233 .csv",      // a space
  "/tmp//export_1792571592233.csv",      // a doubled separator
  "/tmp/exports_1792571592233.csv",      // a near miss on the prefix
  "/var/tmp/export_1792571592233.csv",   // another directory
  "export_1792571592233.csv",            // relative, so it means wherever the process stands
  "/tmp/../etc/passwd",                  // traversal spelled out
  "/tmp/export_1792571592233.csv || rm -rf /tmp", // typed into a column by hand
  "/tmp/export_1792571592233.CSV",       // case is not a free pass either
  "",
  null,
  undefined,
  1792571592233,
];

describe("#35 the column and the numbers behind it", () => {
  it("the schema declares Export.expiresAt as a nullable DateTime", () => {
    const block = schema.slice(schema.indexOf("model Export {"), schema.indexOf("model Export {") + 900);
    assert.match(block, /^\s*expiresAt\s+DateTime\?/m, "the column this round makes true");
    assert.match(block, /completedAt\s+DateTime\?/, "…next to the moment the worker already recorded");
  });

  it("the promise the product makes is a week, and one env key overrides it", () => {
    assert.equal(DEFAULT_RETENTION_MS, WEEK_MS);
    assert.equal(DEFAULT_RETENTION_MS, 604_800_000);
    assert.equal(RETENTION_ENV, "EXPORT_RETENTION_MS");
  });

  it("a caller cannot name the lifetime of the file the server is about to write", () => {
    const ok = validateBody(
      { format: "CSV", fields: ["email"], expiresAt: "2026-01-01T00:00:00.000Z" },
      EXPORT_CREATE,
    );
    assert.ok(ok.ok, "the create door still accepts the export itself");
    const stored = (ok.ok ? ok.data : {}) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(stored, "expiresAt"), false,
      "and the lifetime it was handed is not in what gets written");
    assert.equal(Object.prototype.hasOwnProperty.call(EXPORT_CREATE, "expiresAt"), false);
    // …and there is no way round it: a row is created, run, retried and deleted, never
    // edited, so no verb on either door takes a field that could move a lifetime.
    assert.doesNotMatch(blankComments(detailDoor), /export const PATCH\b/);
    assert.doesNotMatch(blankComments(listDoor), /export const PATCH\b/);
    assert.deepEqual(
      Object.keys(EXPORT_CREATE),
      ["format", "fields", "filterJson", "profileId"],
      "the create table, in full",
    );
  });
});

describe("#35 parseRetentionMs: a mistyped policy falls back, it does not travel", () => {
  const cases: [string, string | undefined | null, number][] = [
    ["absent", undefined, DEFAULT_RETENTION_MS],
    ["null", null, DEFAULT_RETENTION_MS],
    ["empty", "", DEFAULT_RETENTION_MS],
    ["blank", "   ", DEFAULT_RETENTION_MS],
    ["text", "seven", DEFAULT_RETENTION_MS],
    ["NaN", "NaN", DEFAULT_RETENTION_MS],
    ["negative", "-5000", DEFAULT_RETENTION_MS],
    ["signed", "+5000", DEFAULT_RETENTION_MS],
    ["fractional", "1500.5", DEFAULT_RETENTION_MS],
    ["exponent", "1e9", DEFAULT_RETENTION_MS],
    ["thousands separator", "5,000", DEFAULT_RETENTION_MS],
    ["past a safe integer", "99999999999999999999", DEFAULT_RETENTION_MS],
    ["seconds", "25000", 25_000],
    ["padded", " 4000 ", 4_000],
    ["leading zeros", "007", 7],
    ["zero means serve nothing", "0", 0],
    ["one", "1", 1],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name}: ${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(parseRetentionMs(input), expected);
    });
  }

  it("an unset key and a set one, read from an env object rather than the process", () => {
    assert.equal(retentionMs({}), DEFAULT_RETENTION_MS);
    assert.equal(retentionMs({ [RETENTION_ENV]: "25000" }), 25_000);
    assert.equal(retentionMs({ [RETENTION_ENV]: "25000ms" }), DEFAULT_RETENTION_MS);
  });

  it("with no argument it reads the environment the app boots with", () => {
    const had = process.env[RETENTION_ENV];
    try {
      process.env[RETENTION_ENV] = "1234";
      assert.equal(retentionMs(), 1_234);
      delete process.env[RETENTION_ENV];
      assert.equal(retentionMs(), DEFAULT_RETENTION_MS);
    } finally {
      if (had === undefined) delete process.env[RETENTION_ENV];
      else process.env[RETENTION_ENV] = had;
    }
  });
});

describe("#35 expiryFor and retentionVerdict: the arithmetic and the boundary", () => {
  it("adds the retention to the moment the export finished", () => {
    assert.equal(expiryFor(FINISHED, 25_000).toISOString(), "2026-10-21T08:19:36.163Z");
    assert.equal(expiryFor(FINISHED, WEEK_MS).toISOString(), "2026-10-28T08:19:11.163Z");
    assert.equal(expiryFor(FINISHED, 0).getTime(), FINISHED.getTime(), "a zero retention dies at the instant it is born");
  });

  it("takes the running retention when the caller does not name one", () => {
    const had = process.env[RETENTION_ENV];
    try {
      process.env[RETENTION_ENV] = "60000";
      assert.equal(expiryFor(FINISHED).getTime() - FINISHED.getTime(), 60_000);
      delete process.env[RETENTION_ENV];
      assert.equal(expiryFor(FINISHED).getTime() - FINISHED.getTime(), DEFAULT_RETENTION_MS);
    } finally {
      if (had === undefined) delete process.env[RETENTION_ENV];
      else process.env[RETENTION_ENV] = had;
    }
  });

  it("does not touch the date it was given", () => {
    const copy = new Date(FINISHED.getTime());
    expiryFor(FINISHED, 25_000);
    assert.equal(FINISHED.toISOString(), copy.toISOString());
  });

  it("the instant named by expiresAt is already retired", () => {
    const expiry = expiryFor(FINISHED, 25_000);
    assert.equal(retentionVerdict(expiry, new Date(expiry.getTime() - 1)), "served");
    assert.equal(retentionVerdict(expiry, new Date(expiry.getTime())), "retired");
    assert.equal(retentionVerdict(expiry, new Date(expiry.getTime() + 1)), "retired");
  });

  it("null is a promise never made, not a promise kept", () => {
    // 25 real exports in the shared table carry it; folding them into "retired" would be
    // a retirement decided by a migration instead of by an operator.
    assert.equal(retentionVerdict(null, FINISHED), "unstamped");
    assert.equal(retentionVerdict(undefined, FINISHED), "unstamped");
    assert.equal(retentionVerdict(new Date("not a date"), FINISHED), "unstamped", "an unusable clock is not a lifetime");
  });

  it("defaults the clock to now", () => {
    assert.equal(retentionVerdict(new Date(Date.now() + 60_000)), "served");
    assert.equal(retentionVerdict(new Date(Date.now() - 60_000)), "retired");
  });
});

describe("#35 the two refusals stay two sentences", () => {
  it("the retired refusal names the date the export died", () => {
    const expiry = new Date("2026-10-28T08:19:11.163Z");
    const message = retiredExportError(expiry);
    assert.match(message, /retired/);
    assert.match(message, /2026-10-28T08:19:11\.163Z/, "the row's own date, not a vague promise");
    assert.match(message, /re-run/, "and what to do about it");
  });

  it("falls back to a sentence rather than Invalid Date when there is no date", () => {
    assert.doesNotMatch(retiredExportError(null), /Invalid Date/);
    assert.match(retiredExportError(null), /retired/);
  });

  it("the missing-file refusal is word for word the one the door has always given", () => {
    assert.equal(MISSING_EXPORT_FILE_ERROR, "export file expired from this server — re-run the export");
    assert.notEqual(retiredExportError(new Date("2026-10-28T08:19:11.163Z")), MISSING_EXPORT_FILE_ERROR);
    assert.doesNotMatch(MISSING_EXPORT_FILE_ERROR, /retired/, "a lost file is not a retired one");
  });
});

describe("#35 the wiring, scanned from the source", () => {
  it("the table is written from nine places and one of them owns the lifetime", () => {
    // Ten when #35 measured it. #39 deleted `runScheduledExports` — a scheduler no caller
    // had, holding one of the three creates and one of the seven updates — so the count is
    // retargeted rather than relaxed: the eight writes that remain are the eight that can
    // actually run, and the deleted two are the reason this number moved. #43 adds the ninth:
    // the write that puts an export's record down when its worker obeyed a mark. It is pinned
    // as the site that owns *neither* fact — no lifetime, and no file — because a stopped
    // export is the one row on this table that must say it delivered nothing.
    assert.equal(everyWrite.length, 9, "the writes that are reachable: two creates, seven updates");
    const stamped = everyWrite.filter((w) => w.body.includes("expiresAt"));
    assert.equal(stamped.length, 1, "one stamp site, no accidental second one");
    assert.equal(stamped[0].file.replace(src, "src"), "src/lib/exporter.ts");
    assert.match(stamped[0].body, /status: "COMPLETED"/, "and it is the write that finishes the row");
    assert.match(stamped[0].body, /expiresAt: expiryFor\(finishedAt\)/);
    assert.match(stamped[0].body, /completedAt: finishedAt/, "one clock for both facts on the row");
    assert.doesNotMatch(stamped[0].body, /completedAt: new Date\(\)/, "the stamp and the finish are not two instants");
    const putDown = everyWrite.filter((w) => w.body.includes("stoppedExportWrite"));
    assert.equal(putDown.length, 1, "the stop has exactly one write on this table");
    assert.equal(putDown[0].file.replace(src, "src"), "src/lib/exporter.ts", "made from the module's decision, not a second copy of it");
    assert.match(putDown[0].body, /data: stoppedExportWrite\(\)/, "the word is the module's decision, not one spelled out at the write");
    assert.doesNotMatch(putDown[0].body, /expiresAt|filePath/, "naming no bytes here, so naming no lifetime either");
  });

  it("the streaming door asks the verdict before it opens the file", () => {
    const body = blankComments(functionBody(streamDoor, "GET_impl") ?? "");
    const asked = body.indexOf("retentionVerdict(record.expiresAt)");
    const opened = body.indexOf("stat(record.filePath)");
    assert.ok(asked >= 0, "the door asks");
    assert.ok(opened >= 0, "and still streams");
    assert.ok(asked < opened, "the refusal happens before the bytes are read");
    assert.match(body, /retiredExportError\(record\.expiresAt\)/);
    assert.match(body, /MISSING_EXPORT_FILE_ERROR/, "the other 410 quotes the same constant");
    assert.match(body, /status: 410/, "both refusals stay 410 — the file is retired, not reported lost");
  });

  it("the door that hands out the URL refuses a retired export instead of handing it over", () => {
    const body = blankComments(functionBody(detailDoor, "POST_impl") ?? "");
    const branch = body.slice(body.indexOf('action === "download"'));
    const refused = branch.indexOf("retentionVerdict(exportRecord.expiresAt)");
    const handed = branch.indexOf("downloadUrl:");
    assert.ok(refused >= 0, "the door asks");
    assert.ok(refused < handed, "no URL for a file the same module has refused");
    assert.match(branch.slice(0, handed), /retiredExportError\(exportRecord\.expiresAt\)/);
    assert.match(branch.slice(0, handed), /status: 410/);
  });

  it("the worker reads the retention at the moment the export finishes", () => {
    assert.match(retentionModule, /export function expiryFor\(completedAt: Date, ms: number = retentionMs\(\)\)/,
      "the default is decided per call, so the knob belongs to the writing instance");
    assert.match(exporter, /import \{ expiryFor \} from "\.\/export-retention"/);
  });

  it("#35's limit was that serving an export never destroys it, and #43 kept that half", () => {
    // The invariant was never "nothing in this app deletes" — it was "whatever hands a file
    // back does not destroy it". #36 moved deletion to the sweep; #37 added it to the one
    // export door that never serves anything; #43 gave the worker its first `unlink`, with the
    // narrowest subject it could have: the bytes its own run wrote moments before it read the
    // mark. So every place a download passes through still contains no deletion of any kind,
    // and the worker's single removal is reached only through the plan a module hands back.
    const servers = [
      ["the streaming door", streamDoor],
      ["the list door", listDoor],
      ["the retention module, which only decides", retentionModule],
    ] as const;
    for (const [name, file] of servers) {
      assert.doesNotMatch(blankComments(file), /unlink\s*\(|rmSync|\brm\s*\(|rmdir|execSync/, `${name} still deletes nothing`);
    }
    const deletes = blankComments(exporter);
    assert.equal((deletes.match(/\bunlink\(/g) ?? []).length, 1, "one removal in the worker, not one per format");
    assert.match(deletes, /fs\.unlink\(bytes\.filePath\)/, "and it is on the plan's own path, never a re-read column");
    assert.match(deletes, /stoppedExportBytes\(filePath\)/, "asked out of the module that owns the shape");
    assert.match(deletes, /stopped run's file left on disk/, "a removal that failed is printed with the reason, not swallowed");
    // The module is held to more than "no deletion": it cannot even reach a filesystem. Its
    // `"unlink"` is a verb it hands to somebody else, which is the whole design of the round.
    const decides = blankComments(retentionModule);
    assert.doesNotMatch(decides, /from "fs|from "node:fs|require\("fs"/, "the retention module imports no filesystem at all");
    const stopModule = blankComments(readFileSync(`${src}/lib/export-stop.ts`, "utf8"));
    assert.doesNotMatch(stopModule, /from "fs|from "node:fs|\bunlink\s*\(|\brm\s*\(/,
      "and neither does the module that decides a stopped run's bytes — it names an action, it does not perform one");
    assert.match(stopModule, /return planRowDelete\(filePath\)/, "one shape rule in one file, so the two deleters cannot drift apart");
    for (const served of ["GET_impl", "POST_impl"]) {
      const body = blankComments(functionBody(detailDoor, served) ?? "");
      assert.ok(body.length > 0, `${served} exists`);
      assert.doesNotMatch(body, /unlink|rmSync/, `the detail door's ${served} answers with bytes and destroys none`);
    }
    assert.match(retentionModule, /the bytes go too, and only where a date and a shape both say so/,
      "and the module says so out loud");
  });
});

describe("#36 the shape guard: only what the four writers can produce", () => {
  it("the worker writes exactly four artifact paths and the guard accepts every one", () => {
    assert.deepEqual(written, [
      "/tmp/export_1792571592233.csv",
      "/tmp/export_1792571592233.json",
      "/tmp/export_1792571592233.xlsx",
      "/tmp/export_1792571592233.pdf",
    ], "four formats, four literals, nothing else has ever been written");
    for (const path of written) assert.ok(isExportArtifact(path), `${path} must be deletable by policy`);
  });

  it("everything else is refused, including the shapes a column could hold", () => {
    for (const path of notArtifacts) assert.equal(isExportArtifact(path), false, `${String(path)} is not an artifact`);
  });

  it("a millisecond value the worker could actually produce passes, and so does the oldest one on disk", () => {
    assert.ok(isExportArtifact(`/tmp/export_${Date.now()}.csv`));
    assert.ok(isExportArtifact("/tmp/export_1792211058540.csv"), "the four-day-old file measured before the round");
  });
});

describe("#36 planPurge: the date first, then the shape, and never a guess", () => {
  const NOW = new Date("2026-10-21T09:00:00.000Z");
  const PAST = new Date(NOW.getTime() - 1);
  const FUTURE = new Date(NOW.getTime() + 1);
  const ART = "/tmp/export_1792571592233.csv";

  const reasons = (rows: Parameters<typeof planPurge>[0]) => planPurge(rows, NOW).keep.map((k) => `${k.id}:${k.reason}`);

  it("the whole decision table, four reasons and one removal", () => {
    const rows = [
      { id: "live", filePath: ART, expiresAt: FUTURE },
      { id: "boundary", filePath: ART, expiresAt: NOW },
      { id: "gone", filePath: ART, expiresAt: PAST },
      { id: "legacy", filePath: ART, expiresAt: null },
      { id: "broken", filePath: ART, expiresAt: new Date("nope") },
      { id: "fileless", filePath: null, expiresAt: PAST },
      { id: "empty", filePath: "", expiresAt: PAST },
      { id: "hostile", filePath: "/etc/passwd", expiresAt: PAST },
      { id: "nearmiss", filePath: "/tmp/export_1792571592233.txt", expiresAt: PAST },
    ];
    const plan = planPurge(rows, NOW);
    assert.deepEqual(plan.remove, [
      { id: "boundary", filePath: ART, expiresAt: NOW },
      { id: "gone", filePath: ART, expiresAt: PAST },
    ], "two rows earn a deletion, and the first one is the row whose date is exactly now — the same inclusive boundary the door refuses at");
    assert.deepEqual(reasons(rows), [
      "live:served",
      "legacy:unstamped",
      "broken:unstamped",
      "fileless:no file",
      "empty:no file",
      "hostile:path is not an export artifact",
      "nearmiss:path is not an export artifact",
    ]);
  });

  it("the boundary is the same instant the door refuses at, to the millisecond", () => {
    // #35's `retentionVerdict` is inclusive; a purge that used `<` instead would delete a
    // file the door is still willing to open for one more millisecond. Both read the same
    // function, which is the only reason this is true.
    assert.deepEqual(planPurge([{ id: "a", filePath: ART, expiresAt: PAST }], NOW).remove.length, 1);
    assert.deepEqual(planPurge([{ id: "b", filePath: ART, expiresAt: NOW }], NOW).remove.length, 1, "retired at its own instant");
    assert.deepEqual(planPurge([{ id: "c", filePath: ART, expiresAt: FUTURE }], NOW).remove, []);
    assert.equal(retentionVerdict(NOW, NOW), "retired");
  });

  it("the date is asked before the path is looked at", () => {
    // Two things this ordering buys: a served export is never even considered for deletion
    // (so a purge cannot change what its door answers), and a reason a human reads back names
    // the live row as live rather than as a path problem.
    assert.deepEqual(reasons([{ id: "live", filePath: "/etc/passwd", expiresAt: FUTURE }]), ["live:served"]);
    const body = blankComments(functionBody(retentionModule, "planPurge") ?? "");
    assert.ok(body.indexOf("retentionVerdict(row.expiresAt, now)") < body.indexOf("row.filePath"),
      "the verdict is the first gate inside the decision");
    assert.ok(body.indexOf("row.filePath") < body.indexOf("isExportArtifact(row.filePath)"),
      "and the shape is checked only for a row already retired");
  });

  it("not one unstamped row is deleted, whatever path it names", () => {
    // The 25 exports finished before `expiresAt` was ever filled in. Their files stay: a
    // lifetime nobody promised is not a lifetime that passed.
    const legacy = Array.from({ length: 25 }, (_, i) => ({ id: `l${i}`, filePath: `/tmp/export_${1792211058540 + i}.csv`, expiresAt: null }));
    assert.deepEqual(planPurge(legacy, NOW).remove, [], "the sweep takes nothing from the pre-round rows");
    assert.equal(planPurge(legacy, NOW).keep.length, 25);
  });

  it("a plan is a decision, not a side effect", () => {
    const rows = [
      { id: "gone", filePath: ART, expiresAt: PAST },
      { id: "live", filePath: ART, expiresAt: FUTURE },
    ];
    const before = structuredClone(rows);
    const first = planPurge(rows, NOW);
    const second = planPurge(rows, NOW);
    assert.deepEqual(first, second, "the same clock and the same rows give the same plan");
    assert.deepEqual(rows, before, "and the rows come back unchanged");
    assert.deepEqual(Object.keys(first).sort(), ["keep", "remove"]);
  });

  it("every removal is announced with the date that authorized it", () => {
    const [target] = planPurge([{ id: "cmvhuucqa0009daqcqvpdyseg", filePath: ART, expiresAt: PAST }], NOW).remove;
    const line = purgedExportLog(target);
    assert.match(line, /Export cmvhuucqa0009daqcqvpdyseg: retired file removed at \/tmp\/export_1792571592233\.csv/);
    assert.match(line, /retired on 2026-10-21T08:59:59\.999Z/, "the row's own date, not the sweep's clock");
  });

  it("the two refusal sentences are still two sentences after the bytes go", () => {
    // The purge does not add a third answer: a retired row is refused by its date whether or
    // not this sweep removed the file, and `MISSING_EXPORT_FILE_ERROR` keeps its original
    // meaning — the operating system reclaimed something the app never stamped.
    assert.equal(retiredExportError(PAST), "export retired on 2026-10-21T08:59:59.999Z — re-run the export for a fresh file");
    assert.equal(MISSING_EXPORT_FILE_ERROR, "export file expired from this server — re-run the export");
    assert.equal(retentionVerdict(PAST, NOW), "retired", "date first, so the answer cannot depend on the disk");
  });
});

describe("#36 the sweep, scanned from the source", () => {
  const purge = () => blankComments(functionBody(schedulerSource, "purgeRetiredExports") ?? "");

  it("the application deletes files in three places, and all three do it by asking the module", () => {
    // #36 pinned one deleter. #37 added the second, and #43 the third: the worker putting back
    // the bytes its own stopped run wrote. The claim worth keeping has never been the count of
    // files but the rule behind them — every `unlink` in `src/` sits in a function that got its
    // path out of `planPurge`, `planRowDelete`, or the stopped-export decision that delegates to
    // `planRowDelete` — so there is no fourth way to delete a file, and a bug in a `where`
    // clause or a stale column deletes nothing.
    const deletes = /unlink\s*\(|rmSync|\brm\s*\(|rmdir|execSync/;
    const files = srcFiles(src).filter((file) => deletes.test(blankComments(readFileSync(file, "utf8"))));
    assert.deepEqual(files.map((file) => file.replace(src, "src")).sort(), [
      "src/app/api/exports/[id]/route.ts",
      "src/lib/exporter.ts",
      "src/lib/scheduler.ts",
    ], "the minute sweep, the delete door, and a stopped run's own file — a date, a caller who owns the row, and the bytes this worker just made; nobody else");
    for (const file of files) {
      const code = blankComments(readFileSync(file, "utf8"));
      assert.equal((code.match(/\bunlink\(/g) ?? []).length, 1, `${file} calls unlink from exactly one statement`);
      assert.match(code, /planPurge\(|planRowDelete\(|stoppedExportBytes\(/, `${file} deletes only paths the pure module named`);
      assert.match(code, /export-retention|export-stop/, `and asks that module rather than keeping its own regex`);
    }
  });

  it("the unlink only ever runs on a path planPurge handed back", () => {
    const body = purge();
    assert.ok(body.length > 0, "the sweep exists");
    const planned = body.indexOf("planPurge(rows, now)");
    const deleted = body.indexOf("await unlink(");
    assert.ok(planned >= 0 && deleted > planned, "decide, then delete — never the other way round");
    assert.match(body, /for \(const target of plan\.remove\)/, "the loop walks the plan and nothing else");
    assert.match(body, /await unlink\(target\.filePath\)/, "and on the plan's own path, not a re-read column");
  });

  it("the query is a pre-filter, not the decision", () => {
    const body = purge();
    assert.match(body, /status: "COMPLETED", expiresAt: \{ not: null, lte: now \}/,
      "the database narrows the rows it can");
    assert.match(body, /planPurge\(rows, now\)/, "but the same clock is handed to the pure decision, so a bug in the where clause deletes nothing");
  });

  it("a file that is already gone is counted, not reported as a deletion or a failure", () => {
    const body = purge();
    assert.match(body, /code === "ENOENT"/, "/tmp is reclaimed by the operating system on its own schedule");
    assert.match(body, /already gone/);
    assert.doesNotMatch(body, /catch\s*\{\s*\}/, "nothing is swallowed");
    assert.match(body, /console\.warn\(.*could not be removed/, "a real failure is a log line with the reason");
    assert.ok(body.indexOf("report.removed += 1") > body.indexOf("await unlink("),
      "and the count only moves when the unlink answered");
  });

  it("the row keeps every fact it had", () => {
    const body = purge();
    assert.doesNotMatch(body, /prisma\.export\.(update|delete)/, "the sweep touches bytes, not the record");
    assert.doesNotMatch(body, /filePath: null/, "the path stays: it is the audit record of a file that existed");
    const fromSweep = callBodies(schedulerSource, "update");
    assert.equal(fromSweep.length, 1, "the sweep's one export write is the PENDING stamp a profile run makes");
    for (const write of fromSweep) assert.doesNotMatch(write, /filePath|expiresAt/);
  });

  it("both of the sweep's disk legs ride the minute and neither can cost the minute its work", () => {
    const body = blankComments(functionBody(schedulerSource, "runScheduledJobs") ?? "");
    const queued = body.indexOf("prisma.source.findMany(");
    const purged = body.indexOf("await purgeRetiredExports(now)");
    const counted = body.indexOf("await logExportFileCensus(now)");
    assert.ok(purged >= 0 && counted >= 0, "the sweep calls both");
    assert.ok(Math.max(purged, counted) < queued, "both before the calendar, so a disk problem cannot swallow the minute's jobs");
    assert.ok(body.lastIndexOf("try {", purged) > 0, "the purge opens inside a try");
    assert.ok(body.lastIndexOf("try {", counted) > purged, "and the census is inside a second try, not the purge's");
    assert.match(body.slice(purged, counted), /catch/, "whose catch closes before the census is called");
    assert.match(body.slice(counted), /catch/, "with its own catch after it");
    assert.match(body, /Retired export purge did not run this minute/, "one sentence per leg, naming the minute that missed it");
    assert.match(body, /Export file census did not run this minute/, "and the census has its own");
    for (const name of ["purgeRetiredExports", "exportFileCensus", "logExportFileCensus"]) {
      assert.match(schedulerSource, new RegExp(`export async function ${name}\\(now: Date = new Date\\(\\)\\)`),
        `${name} takes the clock, so the decision it makes is testable without waiting for one`);
    }
  });

  it("DELETE used to remove the row and only the row; #37 measures that claim and closes it", () => {
    // #36's version of this test pinned `doesNotMatch(/unlink/)` over DELETE_impl while calling
    // it the orphans' source. The measurement in the module docblock replaces that attribution
    // (an hour of job residue, 31 vanished ids, 24 of them COMPLETED) and the door now takes the
    // bytes it named — which is the half of the orphan problem a door is allowed to solve.
    const body = blankComments(functionBody(detailDoor, "DELETE_impl") ?? "");
    assert.match(retentionModule, /job history from a window in which the table was emptied/,
      "the claim #36 shipped is corrected in the file that shipped it");
    assert.match(retentionModule, /does not touch the \*\*24 orphans\*\*/, "and #36's non-goal is still stated where it was written");
    assert.match(body, /prisma\.export\.delete/);
    assert.match(body, /planRowDelete/);
    assert.match(body, /await unlink\(/);
  });
});

describe("#37 the delete door, plan and order", () => {
  const body = () => blankComments(functionBody(detailDoor, "DELETE_impl") ?? "");
  const rejects = notArtifacts.filter((p): p is string => typeof p === "string" && p.length > 0);

  it("the door's plan is the same question the sweep asks, with the same two answers", () => {
    for (const path of written) {
      assert.deepEqual(planRowDelete(path), { action: "unlink", filePath: path }, `${path} goes with its row`);
    }
    for (const path of rejects) {
      assert.deepEqual(planRowDelete(path), { action: "none", reason: "path is not an export artifact" },
        `${path} is a string a column can hold and a door may not delete`);
    }
    for (const absent of [null, undefined, ""]) {
      assert.deepEqual(planRowDelete(absent), { action: "none", reason: "no file" }, `${String(absent)} names no bytes to take`);
    }
  });

  it("deleting a row is not a retention decision, and the types say so", () => {
    // A caller who deletes an export one millisecond before its date dies deletes it. The date
    // governs the door that serves, never the record, so the plan does not even receive a clock.
    const impl = blankComments(functionBody(retentionModule, "planRowDelete") ?? "");
    assert.ok(impl.length > 0, "the plan exists");
    assert.doesNotMatch(impl, /retentionVerdict|expiresAt|completedAt|now/, "no clock reaches it");
    assert.equal(planRowDelete(`/tmp/export_${Date.now()}.csv`).action, "unlink", "one second from retirement, still removed");
  });

  it("the row goes first, and the path is read before it goes", () => {
    const code = body();
    assert.ok(code.length > 0, "the door exists");
    const read = code.indexOf("select: { workspaceId: true, filePath: true }");
    const deleted = code.indexOf("prisma.export.delete(");
    const unlinked = code.indexOf("await unlink(");
    assert.ok(read >= 0 && read < deleted, "filePath is selected in the same read that authorizes the delete");
    assert.ok(deleted < unlinked, "the record is gone before the disk is touched");
    assert.match(code, /const plan = planRowDelete\(_owned\.filePath\)/,
      "on the column read first, never on anything the request carried");
  });

  it("ownership is checked before anything is destroyed", () => {
    const code = body();
    assert.ok(code.indexOf("assertOwns(request") < code.indexOf("prisma.export.delete("),
      "another workspace's export id is a 401 before it is a deletion");
    assert.match(code, /error: "Not found" \}, \{ status: 404/, "and a row that is not there is still a 404");
  });

  it("every answer after the delete says what happened to the bytes", () => {
    const code = body();
    assert.equal((code.match(/NextResponse\.json\(\{ ok: true/g) ?? []).length, 4,
      "removed, already gone, left on disk, and the plan's own reason — all four as answers");
    assert.doesNotMatch(code, /NextResponse\.json\(\{ ok: true \}\)/,
      "no bare `{ ok: true }` survives: that is the over-claim this round removes");
    for (const state of ['file: "removed"', 'file: "already gone from this server"', 'file: "left on disk"', "file: plan.reason"]) {
      assert.ok(code.includes(state), `the response can say ${state}`);
    }
  });

  it("an absent file is a fact about /tmp, and any other failure is a sentence with its reason", () => {
    const code = body();
    assert.match(code, /code === "ENOENT"/, "the file the row named was already reclaimed");
    assert.match(code, /console\.warn\(.*not removed/, "a real failure is logged with the path and the reason");
    assert.match(code, /fileError: reason/, "and handed back, not folded into a success");
    assert.doesNotMatch(code, /catch\s*\{\s*\}/, "nothing is swallowed");
    assert.doesNotMatch(code, /unlinkSync|rmSync|execSync/, "and not by a second mechanism either");
  });

  it("the door rewrites nothing else about the export", () => {
    const code = body();
    assert.doesNotMatch(code, /prisma\.export\.(update|updateMany|deleteMany|create)/,
      "one row, one delete, no bulk path, no soft delete");
    assert.equal(callBodies(detailDoor, "update").length, 1,
      "the detail door's only export write is still the retry stamp, which does not touch bytes");
  });
});

describe("#37 the census: the number #36 guessed at, now counted", () => {
  const NOW = new Date("2026-10-21T09:00:00.000Z");
  const OLD = 1792211058540;
  const ART = (ms: number, ext = "csv") => `/tmp/export_${ms}.${ext}`;

  it("a name's own millisecond is the stamp, and only a writer's shape has one", () => {
    for (const path of written) {
      assert.equal(artifactStamp(path), 1792571592233, `${path} is its own timestamp`);
    }
    for (const path of notArtifacts) {
      if (typeof path !== "string") continue;
      assert.equal(artifactStamp(path), null, `${path} has no readable instant`);
    }
  });

  it("the whole census table, in one answer per row", () => {
    const young = NOW.getTime() - 16;
    const census = unclaimedExportFiles(
      [
        { path: ART(OLD, "csv"), bytes: 100 },          // unclaimed, old -> counted
        { path: ART(OLD, "json"), bytes: 7 },           // unclaimed, old -> counted
        { path: ART(OLD, "pdf"), bytes: 1912 },         // unclaimed, old -> counted
        { path: ART(young), bytes: 50 },                // unclaimed, 16 ms old -> too young
        { path: ART(OLD, "xlsx"), bytes: 4 },           // claimed by a row -> not residue
        { path: "/tmp/notes.txt", bytes: 9 },           // not an export, not even judged
        { path: "/var/tmp/export_999.csv", bytes: 9 },  // and not in this directory
      ],
      [ART(OLD, "xlsx")],
      NOW,
    );
    assert.deepEqual(census.files.map((f) => f.path), [ART(OLD, "csv"), ART(OLD, "json"), ART(OLD, "pdf")],
      "the residue, in the order the listing gave it");
    assert.equal(census.bytes, 100 + 7 + 1912, "bytes of the counted files and nothing else");
    assert.equal(census.inFlight, 1, "the 16 ms file is an export being born, not an orphan");
  });

  it("the boundary is the grace window, and a file cannot be residue inside it", () => {
    // The gap measured across the live rows is 2.3-16.1 ms; the window is 60,000 ms. Being wrong
    // in the generous direction costs one fewer in the log, being wrong the other way costs a
    // caller their export, so the comparison is deliberately not tight.
    const at = unclaimedExportFiles([{ path: ART(NOW.getTime() - IN_FLIGHT_GRACE_MS), bytes: 1 }], [], NOW);
    const justInside = unclaimedExportFiles([{ path: ART(NOW.getTime() - IN_FLIGHT_GRACE_MS + 1), bytes: 1 }], [], NOW);
    assert.equal(at.files.length, 1, "exactly at the window it is counted");
    assert.equal(justInside.inFlight, 1, "one millisecond inside it, it is not");
    assert.equal(at.bytes, 1);
    assert.equal(justInside.files.length, 0, "and it is not in the byte total either");
  });

  it("the measured state of this directory is reproducible, and the named half is never touched", () => {
    const named = Array.from({ length: 25 }, (_, i) => ART(OLD + i * 1000));
    const unclaimed = Array.from({ length: 24 }, (_, i) => ART(OLD + 100000 + i * 1000, i % 2 ? "json" : "csv"));
    const listed = [...named, ...unclaimed].map((path) => ({ path, bytes: 100 }));
    const before = structuredClone(listed);
    const census = unclaimedExportFiles(listed, named, NOW);
    assert.deepEqual(census.files.map((f) => f.path), unclaimed, "exactly the 24 that name no row");
    assert.equal(census.bytes, 2400);
    assert.deepEqual(listed, before, "the listing it is handed comes back unchanged");
  });

  it("nothing about a file with no row is invented, and nothing is decided either", () => {
    const census = unclaimedExportFiles([{ path: ART(OLD), bytes: 3 }], [], NOW);
    assert.deepEqual(census.files, [{ path: ART(OLD), bytes: 3 }], "the same path and size it was given");
    const impl = blankComments(functionBody(retentionModule, "unclaimedExportFiles") ?? "");
    assert.doesNotMatch(impl, /unlink|rm|delete|splice|push\(.*Date/, "it counts; only planPurge and planRowDelete name an action");
  });

  it("the sentence says the number, the bytes, and why the answer is not a deletion", () => {
    const line = censusLog({ files: [{ path: ART(OLD), bytes: 1528 }], bytes: 1528, inFlight: 0 });
    assert.match(line, /census: 1 files shaped like exports in \/tmp are named by no row/, "the count");
    assert.match(line, /1528 bytes/, "the bytes");
    assert.match(line, /no expiry, no status and no workspace to decide from/, "the reason it stops at a number");
    assert.doesNotMatch(line, /too new to judge/, "and nothing about files that are not there");
    const withYoung = censusLog({ files: [], bytes: 0, inFlight: 2 });
    assert.match(withYoung, /census: 0 files/, "a clean directory is still a sentence, not silence");
    assert.match(withYoung, /2 named by a timestamp too new to judge/, "and the young ones are named as such");
  });

  it("the census is a log line, not a door: no API surface mentions it", () => {
    const doors = srcFiles(new URL("../../src/app", import.meta.url).pathname);
    assert.ok(doors.length > 0, "the app's routes were scanned");
    for (const file of doors) {
      assert.doesNotMatch(blankComments(readFileSync(file, "utf8")), /census|unclaimedExportFiles/,
        `${file.replace(src, "src")} — an unclaimed file has no workspaceId, so no tenant could authorize this count`);
    }
  });

  it("the boundary reads the disk it is allowed to read, and only lists it", () => {
    const census = blankComments(functionBody(schedulerSource, "exportFileCensus") ?? "");
    assert.ok(census.length > 0, "the sweep's census exists");
    assert.match(census, /readdir\("\/tmp", \{ withFileTypes: true \}\)/, "one directory, named in the code");
    assert.match(census, /entry\.isFile\(\) && EXPORT_FILE_NAME\.test\(entry\.name\)/,
      "filtered to export shapes before anything is stat'ed, so /tmp's other 300-odd entries are not read");
    assert.match(census, /prisma\.export\.findMany\(\{ select: \{ filePath: true \} \}\)/,
      "and the index it compares against is the whole table's paths, not one workspace's");
    assert.doesNotMatch(census, /unlink|rmSync|prisma\.export\.(update|delete|create)/, "it cannot delete a file");
    assert.match(census, /catch \{\s*return null;/, "a file that vanishes between listing and stat is simply not counted");
    const listed = [...blankComments(schedulerSource).matchAll(/const EXPORT_FILE_NAME = \/(.+?)\/;/g)].map((m) => m[1]);
    const guarded = [...blankComments(retentionModule).matchAll(/const EXPORT_ARTIFACT = \/(.+?)\/;/g)].map((m) => m[1]);
    assert.equal(listed.length, 1, "one name filter in the sweep");
    assert.equal(guarded.length, 1, "one path guard in the module");
    assert.equal(listed[0], guarded[0].replace("^\\/tmp\\/", "^"),
      "the listing and the guard are the same four extensions, one directory apart");
  });

  it("it prints when the number moves and not when it does not", () => {
    const leg = blankComments(functionBody(schedulerSource, "logExportFileCensus") ?? "");
    assert.ok(leg.length > 0, "the logging leg exists");
    assert.match(leg, /const line = censusLog\(census\)/, "the sentence is the module's, not assembled here");
    assert.match(leg, /if \(line !== lastCensusLine\)/, "printed only when it changed");
    assert.ok(leg.indexOf("lastCensusLine = line") < leg.indexOf("console.info(line)"),
      "remembered before it is printed, so a throw cannot make the next minute repeat it");
    assert.match(schedulerSource, /let lastCensusLine: string \| null = null;/,
      "instance state, not a table: a restart gets one fresh line, which is the point of the round");
    assert.doesNotMatch(leg, /prisma\.export\.(update|delete|create)/, "and it writes nothing anywhere");
  });
});
