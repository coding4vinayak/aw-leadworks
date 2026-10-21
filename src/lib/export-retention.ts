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
 * - **A retired export is a refused door, not deleted bytes.** This round stops
 *   *serving* the file after its date; the `unlink` and the sweep that would call it
 *   are the next round's work, and until then the honest sentence is *the door no longer
 *   opens after the date and the file is still where the worker put it*.
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
