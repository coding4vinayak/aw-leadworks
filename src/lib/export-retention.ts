/**
 * #35 — `Export.expiresAt` is a lifetime, and a lifetime has to be *set* somewhere and
 * *read* somewhere, or it is a column that only looks like a promise.
 *
 * The column has been in the schema since `init_postgres` (`DateTime?`, so a row can say
 * "no lifetime"), the worker has always had the moment it finished in hand two lines
 * above, and every export door has handed the key back to whoever asked. Nothing ever
 * filled it and nothing ever compared it to a clock. Measured against the running app
 * before this round — a CSV export created through `POST /api/exports`, polled to
 * `COMPLETED`, downloaded twice:
 *
 *   1. the create door returned the whole row with **`expiresAt: null`** and the
 *      completed row, 1130 ms later, returned it again with **`expiresAt: null`** next to
 *      a real `completedAt`, a real `filePath` and a real `fileSize` — the row named a
 *      file of 16 leads' contact details and said nothing about how long it would answer;
 *   2. both downloads were **`200`, 918 bytes each**;
 *   3. the table held **25 `COMPLETED` exports and 0 with an expiry stamped**, the oldest
 *      finished **four days earlier**, its file still on disk at `/tmp/export_1792211058540.csv`
 *      and still served — `200`, 1528 bytes;
 *   4. **the app already speaks of expiry it never records**: the download door's refusal
 *      is `{ error: "export file expired from this server — re-run the export" }` at 410,
 *      and that branch fires only when `stat`/`readFile` throws — i.e. when the operating
 *      system happened to reclaim `/tmp`. The word "expired" was in the sentence with no
 *      date behind it anywhere, and a row whose file was reclaimed was indistinguishable
 *      from a row whose file was never written.
 *
 * So this module does the two things that make the column true, and only those:
 * `expiryFor` says when a finished export dies, at the one write that finishes one
 * (`src/lib/exporter.ts`'s `COMPLETED` update — the row that names the file is the row
 * that says how long it lives), and `retentionVerdict` says, from a row and a clock,
 * whether the door opens — asked **before** the file is opened, so a retired export is
 * refused by policy rather than by accident, with its own sentence naming the date it
 * died. Two doors ask (`GET /api/exports/{id}/download` and `?action=download`, which
 * used to hand out a URL to a file it could no longer serve); the verdict and both
 * messages live here, so the refusal the API gives and the reason a test asserts on are
 * one rule spelled once.
 *
 * `EXPORT_RETENTION_MS` is the operator's knob and defaults to seven days. It is read
 * **when the export finishes**, not when it is served, which is what makes a value as
 * short as a demo's twenty-five seconds harmless: the lifetime belongs to the row, stamped
 * by the instance that wrote the file, so turning the knob down cannot retire anything that
 * already exists — and an instance configured for twenty-five seconds and an instance
 * configured for a year can serve the same table without arguing about it. A value that is
 * not a plain non-negative integer falls back to the default rather than becoming `NaN`,
 * because `NaN` would travel into a `Date` and then into every row finished after it.
 * Zero is a legal value: it means "serve nothing, re-run everything", which is a
 * decision an operator is entitled to make badly.
 *
 * Limits this module will not pretend away:
 *
 * - **A retired export is a refused door before it is anything else.** The `#35` round
 *   stopped *serving* the file after its date and left the bytes exactly where the worker
 *   put them; `#36`, below, is the round that reclaims them. Both halves are here so the
 *   order is visible: the verdict is always asked first, the purge never changes what a door
 *   answers, and a file that has already been reclaimed by the operating system is still
 *   refused by the missing-file sentence rather than by a lie about retirement.
 * - **A row stamped before this round stays served.** `null` is not "expired", it is "no
 *   lifetime was ever promised", and every export finished before this round carries it —
 *   25 of them in the table the round was measured against. Silently refusing those on the
 *   strength of a column nobody ever filled would be a behaviour change decided by a
 *   migration rather than by an operator. `retentionVerdict` names that third case
 *   (`"unstamped"`) instead of folding it into `"served"`, so a row that was never given a
 *   lifetime is never mistaken for one that was given a long one.
 * - **Nothing that has not finished can be retired.** A `PENDING`, `PROCESSING`, `FAILED`
 *   or cancelled export has no `completedAt` to date a lifetime from, and the doors
 *   already refuse it as not-yet-downloadable; the stamp goes only on the row that names
 *   a file.
 * - **Callers cannot set it.** `EXPORT_CREATE` accepts `format`, `fields`, `filterJson`
 *   and `profileId` and no caller has ever been able to name the lifetime of the file the
 *   server is about to write — a retention the requester chooses is not a retention.
 *
 * ## #36 — the bytes go too, and only where a date and a shape both say so
 *
 * Refusing the door left the disk growing, and measured against the running app the day
 * `#35` shipped it was not a hypothetical:
 *
 *   1. **27 `COMPLETED` export rows, 25 of them unstamped, 2 stamped — and both of those
 *      already past their date.** Both retired files were still on disk, byte-exact:
 *      `/tmp/export_1792571592233.csv` at 4,195 bytes and `/tmp/export_1792571761063.csv`
 *      at 957, the rows still `COMPLETED`, still naming them, still answering 410;
 *   2. **51 files matching `/tmp/export_*` in total against 27 rows, so 24 of them are
 *      named by no row at all.** This round blamed `DELETE /api/exports/{id}`; the section
 *      below measures that claim and replaces it — the residue is a table emptied inside one
 *      hour, and the door that deletes a row had never been walked here. Either way the file
 *      is orphaned the moment the row that is the only index to it goes;
 *   3. **0 rows whose file was missing**, i.e. the missing-file 410 had never actually fired
 *      in this database; and
 *   4. `grep` over `src/`: four sites write a `/tmp/export_<millis>.<ext>`, and **zero
 *      sites delete anything**. The app had never removed a file it created.
 *
 * So `#36` adds the third verb to this module — `planPurge(rows, now)`, a pure decision that
 * says which named files a sweep may reclaim and, for every row it does not touch, which of
 * four reasons said so. The `unlink` itself lives at the boundary (`src/lib/scheduler.ts`,
 * on the same once-a-minute sweep that already queues the day's work), because a decision
 * that can be tested with no disk and no database is a decision a test can actually pin.
 *
 * The order inside that decision is not interchangeable, and each step is here because
 * something specific would go wrong otherwise:
 *
 * - **The date is asked first**, before the path is looked at, which is what makes the
 *   invariant *a purge cannot change what a door answers* true by construction: every file
 *   this reclaims was already refused by `retentionVerdict` at the moment the row was read,
 *   and the row keeps its `filePath`, `fileSize` and `COMPLETED` status afterwards. A
 *   retired export reads the same before its bytes go and after — the sentence is the
 *   retired one both times, never the missing-file one.
 * - **Then the shape.** `/tmp/export_<digits>.<csv|json|xlsx|pdf>` and nothing else, checked
 *   *before* the first `unlink` this application has ever attempted. The path being deleted
 *   comes out of a database column, and a column can hold anything: a row edited by hand, a
 *   future writer that stores a user-supplied name, a `../../` someone typed into a
 *   `psql` prompt. `filePath` has only ever been written by the four sites above, so today
 *   the guard rejects nothing — a unit test proves the guard accepts every shape those four
 *   writers build, and a source scan proves they are still the only ones — but the guard is
 *   what makes "we only delete files we wrote" a rule instead of a hope.
 * - **`"unstamped"` is never deleted.** The same reasoning that keeps a `null` row served
 *   keeps it on disk: no lifetime was ever promised, so nothing has expired, and silently
 *   reclaiming the output of the 25 exports finished before this column existed would be a
 *   deletion decided by a migration rather than by an operator.
 * - **A row that names no file is a no-op, not an error.** `filePath` is nullable and a
 *   `FAILED` export never got a path; `planPurge` reports `"no file"` and moves on.
 *
 * What `#36` deliberately does not do: it does not touch the **24 orphans**, the files no
 * `Export` row names. Reclaiming them needs a rule about what a file means when its record
 * is gone, and `DELETE /api/exports/{id}` needs deciding first — deleting the row's bytes
 * with the row, or refusing to delete the row while its file is served. Both are behaviour
 * changes for the next round to measure, so this one counts them and leaves them alone. It
 * also does not clear `filePath`, shrink the row, or add a column: the row is the audit
 * record of an export that happened, and "the file it wrote is no longer here" is a fact the
 * date already tells.
 *
 * ## #37 — a deleted row takes its file, and the files with no row stop being invisible
 *
 * The two non-goals above are the same object seen from both doors, and measuring them corrected
 * a sentence this file shipped with. It named `DELETE /api/exports/{id}` as the source of the 24
 * orphans. The table says otherwise: `Job` rows of type `EXPORT` number **60 against 29 `Export`
 * rows**, and **all 31** of the jobs naming an `exportId` that has no row were created inside the
 * single hour **2026-10-17 07:00**, **24** of them `COMPLETED` — that 24, in the same five
 * minutes (07:40–07:45) the orphan mtimes occupy. The demo never calls `DELETE` on an export and
 * its first export code was committed roughly three hours after that window, no test calls the
 * four writers, and three sampled orphans have `atime == mtime`, so nobody ever downloaded them
 * either. The residue is therefore **job history from a window in which the table was emptied**,
 * and `DELETE`'s measured contribution to it is *zero rows in this database* — the honest version
 * of "the door that deletes a row leaves its file behind" being that the door had never been
 * walked here. That is a statement about the data, not a proof about the code: the door would
 * have left the file, and it still would have until this round.
 *
 * So `planRowDelete(filePath)` is the same shape question `planPurge` asks, with the same two
 * reasons for saying no, asked by `DELETE /api/exports/{id}` after it has removed the row and
 * before it touches the disk. The order is the round's only new mechanism and it is chosen out
 * of the two failures available: a row that outlives its file is a download door pointing at
 * nothing — the state the operating system used to produce by reclaiming `/tmp`, and the reason
 * `#35` had to write a second 410 sentence for it — while a file that outlives its row is the
 * state this directory is already full of. One is a broken promise to a caller and the other is
 * 65,996 bytes answering to nobody, so the row goes first and a failed `unlink` is reported in
 * the response rather than retried, rolled back, or hidden behind `{ ok: true }`.
 *
 * `unclaimedExportFiles(files, namedPaths, now)` makes the other half visible: it counts, and it
 * is the only function in this file that returns no instruction to delete anything. A file with
 * no row has no `expiresAt`, no `status` and — decisively — no `workspaceId`, so there is no
 * policy to apply to it and no tenant for a door to answer it to; the number goes to the
 * server's stdout, not to an API. It also sets aside the files whose own name is younger than
 * `IN_FLIGHT_GRACE_MS`, because the path is built before the row that names it is written: the
 * gap between the millisecond in a filename and its row's `completedAt`, measured across the 25
 * live rows, is **2.3–16.1 ms**. A "delete what no row names" sweep would be deleting exports
 * being born, which is why that idea stays out of the code and the count stays in the log.
 */

/** The promise the product makes when the operator says nothing: a week. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The single environment key that overrides it, read when an export finishes. */
export const RETENTION_ENV = "EXPORT_RETENTION_MS";

/**
 * `EXPORT_RETENTION_MS` as a number, or the default. Strictly digits: `Number("1e9")` is
 * `1000000000` and `parseInt("1500.5")` is `1500`, both of which would silently keep part
 * of what an operator mistyped, and a mistyped retention is a policy that got guessed.
 */
export function parseRetentionMs(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return DEFAULT_RETENTION_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_RETENTION_MS;
  const ms = Number(trimmed);
  return Number.isSafeInteger(ms) ? ms : DEFAULT_RETENTION_MS;
}

/** The retention this instance applies to exports it finishes from here on. */
export function retentionMs(env: Record<string, string | undefined | null> = process.env): number {
  return parseRetentionMs(env[RETENTION_ENV]);
}

/** When an export that finished at `completedAt` stops being served. */
export function expiryFor(completedAt: Date, ms: number = retentionMs()): Date {
  return new Date(completedAt.getTime() + ms);
}

/**
 * `served` — before the date, open the file.
 * `retired` — at or after it, refuse with `retiredExportError`.
 * `unstamped` — no lifetime was ever recorded, which is the state every export written
 * before this round is in, and is served rather than judged.
 */
export type RetentionVerdict = "served" | "retired" | "unstamped";

/**
 * The boundary is inclusive: the instant named by `expiresAt` is already retired, so a
 * row cannot be served at the same millisecond it is said to stop being served.
 */
export function retentionVerdict(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): RetentionVerdict {
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) return "unstamped";
  return expiresAt.getTime() <= now.getTime() ? "retired" : "served";
}

/** The refusal a retired export gets. Names the date it died, because the row knows it. */
export function retiredExportError(expiresAt: Date | null): string {
  const when = expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
    ? expiresAt.toISOString()
    : "its retention date";
  return `export retired on ${when} — re-run the export for a fresh file`;
}

/**
 * The other 410: the row says where its file is and the file is not there. Kept word for
 * word from the route it came from and living beside `retiredExportError` so the two
 * refusals stay two sentences — a re-runnable policy refusal and an accidental missing
 * one are different things to an operator, and this round exists in part because the app
 * had only the second sentence.
 */
export const MISSING_EXPORT_FILE_ERROR = "export file expired from this server — re-run the export";

/**
 * Every path `src/lib/exporter.ts` has ever written an export to: the directory it hardcodes
 * and the four extensions its four format branches pick, with `Date.now()` — digits, no sign,
 * no separators — between. Nothing else in the universe is an export artifact, and a purge
 * that cannot say which files it wrote is a purge that deletes whatever a column happened to
 * contain.
 */
const EXPORT_ARTIFACT = /^\/tmp\/export_\d+\.(csv|json|xlsx|pdf)$/;

/** Is this string a path the export worker could have produced? Never throws, never touches the disk. */
export function isExportArtifact(filePath: unknown): filePath is string {
  return typeof filePath === "string" && EXPORT_ARTIFACT.test(filePath);
}

/** The three columns a purge decision reads. Anything with these is enough to decide. */
export type ExportRowLite = {
  id: string;
  filePath?: string | null;
  expiresAt?: Date | null;
};

/** A file the sweep is permitted to reclaim. */
export type PurgeTarget = { id: string; filePath: string; expiresAt: Date };

/** Why a row's bytes stay where they are. The four cases are the whole decision table. */
export type PurgeReason = "served" | "unstamped" | "no file" | "path is not an export artifact";

export type PurgePlan = {
  remove: PurgeTarget[];
  keep: Array<{ id: string; reason: PurgeReason }>;
};

/**
 * Which named files may go, and for the rest, which of four reasons said so. Pure: no disk,
 * no database, no clock of its own, so the whole table is testable and the caller's `where`
 * clause is only ever a pre-filter — a row handed in early is still judged here by its own
 * date before anything is deleted.
 */
export function planPurge(
  rows: readonly ExportRowLite[],
  now: Date = new Date(),
): PurgePlan {
  const remove: PurgeTarget[] = [];
  const keep: Array<{ id: string; reason: PurgeReason }> = [];

  for (const row of rows) {
    const verdict = retentionVerdict(row.expiresAt, now);
    if (verdict === "served") {
      keep.push({ id: row.id, reason: "served" });
      continue;
    }
    if (verdict === "unstamped") {
      // No lifetime was ever promised, so nothing has expired and nothing is reclaimed.
      keep.push({ id: row.id, reason: "unstamped" });
      continue;
    }
    if (!row.filePath) {
      keep.push({ id: row.id, reason: "no file" });
      continue;
    }
    if (!isExportArtifact(row.filePath)) {
      keep.push({ id: row.id, reason: "path is not an export artifact" });
      continue;
    }
    remove.push({ id: row.id, filePath: row.filePath, expiresAt: row.expiresAt as Date });
  }

  return { remove, keep };
}

/**
 * The line the sweep prints for each file it takes away. Kept beside the decision so the
 * log a demo greps for and the plan a unit test asserts on are the same rule, and so the
 * sentence records the date that authorized the deletion, not just the path it removed.
 */
export function purgedExportLog(target: PurgeTarget): string {
  return `Export ${target.id}: retired file removed at ${target.filePath} (retired on ${target.expiresAt.toISOString()})`;
}
/**
 * #37 — the two answers `DELETE /api/exports/{id}` may give about the bytes its row named,
 * spelled with the words `planPurge` already uses so "a path this application wrote" stays one
 * rule in one file. `"served"` and `"unstamped"` are absent because deleting a row is not a
 * retention decision: an export one minute from its date is still deleted when its caller asks,
 * and the date governs serving, not recordkeeping.
 */
export type RowDeleteSkip = Extract<PurgeReason, "no file" | "path is not an export artifact">;

export type RowDeletePlan =
  | { action: "unlink"; filePath: string }
  | { action: "none"; reason: RowDeleteSkip };

/**
 * What the door may do with the path a deleted row carried. `none` is not a refusal of the
 * delete — by the time this is acted on the row is gone — it is a file deliberately left where it
 * is, reported to the caller as such.
 */
export function planRowDelete(filePath: string | null | undefined): RowDeletePlan {
  if (!filePath) return { action: "none", reason: "no file" };
  if (!isExportArtifact(filePath)) return { action: "none", reason: "path is not an export artifact" };
  return { action: "unlink", filePath };
}

/** A file a directory listing can offer, with the one fact a `stat` adds. */
export type DiskFile = { path: string; bytes: number };

/**
 * How young an unclaimed artifact has to be before this counts it as possibly still being written
 * rather than as residue. Generous by a factor of ~4,000 over the largest measured gap (16.1 ms)
 * because the cost of being wrong is deleting someone's export mid-flight, and the cost of
 * waiting a minute is a census that says one fewer, once.
 */
export const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * The instant an artifact path names — the `Date.now()` its writer interpolated — or null for a
 * path the four writers cannot produce. Reading the stamp out of the name is what lets the census
 * judge age without trusting, or needing, a `stat`'s timestamps.
 */
export function artifactStamp(filePath: string): number | null {
  if (!isExportArtifact(filePath)) return null;
  const stamped = /^\/tmp\/export_(\d+)\./.exec(filePath);
  if (!stamped) return null;
  const ms = Number(stamped[1]);
  return Number.isSafeInteger(ms) ? ms : null;
}

export type UnclaimedCensus = {
  /** files shaped like exports, named by no row, old enough to have been named by one */
  files: DiskFile[];
  bytes: number;
  /** unclaimed files inside `IN_FLIGHT_GRACE_MS`: an export being born, not an orphan */
  inFlight: number;
};

/**
 * Count them. Nothing here deletes: `planPurge` and `planRowDelete` act on a row's own date and a
 * row's own path, and a file with no row has neither, so there is no decision to make about it —
 * only a number worth seeing, which is what the minute sweep logs.
 */
export function unclaimedExportFiles(
  files: readonly DiskFile[],
  namedPaths: Iterable<string>,
  now: Date = new Date(),
  graceMs: number = IN_FLIGHT_GRACE_MS,
): UnclaimedCensus {
  const named = new Set(namedPaths);
  const unclaimed: DiskFile[] = [];
  let bytes = 0;
  let inFlight = 0;
  for (const file of files) {
    if (named.has(file.path)) continue;
    const stamp = artifactStamp(file.path);
    if (stamp === null) continue;
    if (now.getTime() - stamp < graceMs) {
      inFlight += 1;
      continue;
    }
    unclaimed.push(file);
    bytes += file.bytes;
  }
  return { files: unclaimed, bytes, inFlight };
}

/** The sweep's one sentence about the files it is leaving alone, and the reason it leaves them. */
export function censusLog(census: UnclaimedCensus): string {
  const young = census.inFlight > 0 ? `, ${census.inFlight} named by a timestamp too new to judge` : "";
  return `Export file census: ${census.files.length} files shaped like exports in /tmp are named by no row `
    + `(${census.bytes} bytes${young}) — left alone: no row, so no expiry, no status and no workspace to decide from`;
}
