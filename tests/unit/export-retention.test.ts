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
// The live proof is `demo/run-demo.sh leadworks` STEP 16; everything here is reachable
// without a database, so none of these tests asks for one.
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
  expiryFor,
  parseRetentionMs,
  retentionMs,
  retentionVerdict,
  retiredExportError,
} from "../../src/lib/export-retention";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const exporter = at("../../src/lib/exporter.ts");
const streamDoor = at("../../src/app/api/exports/[id]/download/route.ts");
const detailDoor = at("../../src/app/api/exports/[id]/route.ts");
const listDoor = at("../../src/app/api/exports/route.ts");
const retentionModule = at("../../src/lib/export-retention.ts");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The row this round is about, as the doors see it: a finished export, one clock. */
const FINISHED = new Date("2026-10-21T08:19:11.163Z");

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

  it("the table is written from ten places and one of them owns the lifetime", () => {
    assert.equal(everyWrite.length, 10, "the ten writes measured before the round: three creates, seven updates");
    const stamped = everyWrite.filter((w) => w.body.includes("expiresAt"));
    assert.equal(stamped.length, 1, "one stamp site, no accidental second one");
    assert.equal(stamped[0].file.replace(src, "src"), "src/lib/exporter.ts");
    assert.match(stamped[0].body, /status: "COMPLETED"/, "and it is the write that finishes the row");
    assert.match(stamped[0].body, /expiresAt: expiryFor\(finishedAt\)/);
    assert.match(stamped[0].body, /completedAt: finishedAt/, "one clock for both facts on the row");
    assert.doesNotMatch(stamped[0].body, /completedAt: new Date\(\)/, "the stamp and the finish are not two instants");
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

  it("this round closes the door and does not touch the bytes — the stated limit", () => {
    const deleters: string[] = [];
    for (const file of [exporter, streamDoor, detailDoor, retentionModule, at("../../src/lib/scheduler.ts")]) {
      if (/unlink|rmSync|\brm\(/.test(blankComments(file))) deleters.push(file.slice(0, 40));
    }
    assert.deepEqual(deleters, [], "no unlink yet: a retired export's file is still where the worker put it");
    assert.match(retentionModule, /refused door, not deleted bytes/);
  });
});
