// Can this instance actually run a scrape, and what to say when it cannot.
//
// #39 measured the two answers separately, because the app had been stating neither.
//
// The premise is a door that hands back a job id for work nothing can do. `WEB_SCRAPER`
// is one of the five `Source.type` values a caller may write, `POST /api/sources/{id}?action=run`
// mints a `Job` and enqueues it, and the worker's first act is `chromium.launch()`. On an
// instance that has no browser — this box among them: `playwright@1.64` is a dependency,
// nothing in `package.json` installs a browser (`postinstall` is absent), and
// `~/.cache/ms-playwright` does not exist — every scrape dies on the launch. Measured:
// three sources run in a row, all three jobs `FAILED`, and all three wrote the same
// the same banner into `Job.error` and `Source.lastRunError`:
//
//   browserType.launch: Executable doesn't exist at /home/opc/.cache/ms-playwright/
//   chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell
//   ╔═══════════╗║ Looks like Playwright was just installed or updated.║…
//
// So the row's own "how did my last run go" column carried a box-drawing banner, the door
// that minted the doomed job answered 200 with a `jobId`, and nothing anywhere said the
// one fact a buyer needs before pointing a schedule at a scraper: *this instance cannot
// scrape*. That is not a bug in the scraper, and this module does not pretend to fix one —
// it is the absence of a stated capability, stated.
//
// The second answer is the one that matters more, and it is the reason this file sits next
// to `egress.ts` rather than inside the scraper. The identical banner hid it: `chromium.launch()`
// dies before any address is opened, so nothing the three runs printed could distinguish
// `https://example.com/` from `file:///etc/passwd` — and the source, read straight after, says
// `page.goto(config.url)` with nothing between the row and the wire. `src/lib/egress.ts` is the
// vendored policy for exactly that shape — an address this process will connect to because a caller
// named it — and the scrape path never called it. `tests/unit/egress-sites.test.ts` did not
// see the gap either: its census matches a callee whose name contains `fetch`, and this
// app's one navigation is `page.goto`, so the single site where a caller's address reaches a
// wire the server itself opens was the one site the guard could not read. Both halves are
// fixed in `scraper.ts`; this file is the capability half, with no browser, no filesystem and
// no database behind its answers — which is the same reason a deployment without a browser is
// still allowed to have an opinion about scraping.

import { classifyTarget } from "./egress";

/** What the caller looked at, before this module decides what it means. */
export type BrowserProbe = {
  /** The path this build's browser library says it would launch, or null when it cannot say. */
  executablePath: string | null;
  /** Whether that path is actually on this filesystem. */
  present: boolean;
};

export type Capability =
  | { runnable: true; executablePath: string }
  | { runnable: false; reason: string };

/** The command that puts a browser where this build looks for one. */
export const BROWSER_INSTALL_COMMAND = "npx playwright install chromium";

/**
 * The one sentence a row, a door and a health page should all use for the same fact.
 *
 * Both states carry `BROWSER_INSTALL_COMMAND`, because both are fixed by it — the second
 * one is the case where the install is broken rather than missing, and the operator still
 * has no other command to reach for. What the two must not share is a path: printing
 * `no browser at null` is the sentence that blames the operator's machine for a resolver
 * that gave up.
 */
export function browserMissingReason(executablePath: string | null): string {
  return executablePath === null
    ? `this instance cannot run a scrape — this build's browser library does not resolve an executable path, so there is nothing on disk to look for; ${BROWSER_INSTALL_COMMAND} is the command that normally puts one there`
    : `this instance cannot run a scrape — no browser at ${executablePath}; ${BROWSER_INSTALL_COMMAND} puts it there`;
}

/**
 * The verdict, from a probe.
 *
 * Pure by construction: it decides, it does not look. The looking is `scraper.ts`'s job
 * (`chromium.executablePath()` plus `existsSync`), which is also what keeps this answerable
 * on an instance that has neither of those things.
 */
export function scrapeCapability(probe: BrowserProbe): Capability {
  if (probe.executablePath === null) return { runnable: false, reason: browserMissingReason(null) };
  if (!probe.present) return { runnable: false, reason: browserMissingReason(probe.executablePath) };
  return { runnable: true, executablePath: probe.executablePath };
}

/**
 * The banner Playwright throws when the executable is missing, in the shape this file can
 * recognise. `Executable doesn't exist at <path>` was read off three real failures on this
 * box; the apostrophe is typed both ways by different versions, so neither is required.
 */
const MISSING_EXECUTABLE = /Executable doesn.t exist at\s+(\S+)/;

/**
 * Turn a launch failure into the sentence, or say it was not a capability failure.
 *
 * `null` means "this error is about the page, not about the instance" and the caller keeps
 * the original message — inventing a tidier one for a real scrape error would trade the
 * box-drawing banner for a different lie.
 */
export function classifyLaunchFailure(message: string): string | null {
  const found = MISSING_EXECUTABLE.exec(message);
  if (!found) return null;
  return browserMissingReason(found[1]);
}

/**
 * The address this row would navigate to, if it names one.
 *
 * Deliberately not filtered on `Source.type`. The sweep mints a `SCRAPE` job for any active
 * source whose cadence matches and `runScrapeJob` reads `job.config.url` whatever the type
 * column says — so an `API`-labelled row holding a url is a scrape target as far as the
 * browser is concerned, and a check that only fired on `WEB_SCRAPER` would leave the address
 * the worker actually opens unjudged. #38's own demo step stores `type: "API"` sources whose
 * config points at its hook server; that is the case this function sees and a type-shaped
 * guard would have missed.
 */
export function scrapeTarget(config: unknown): string | null {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const url = (config as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

/** What a `WEB_SCRAPER` row without an address is being asked to open. */
export const NO_TARGET_REASON =
  "a scrape navigates to the address in config.url, and this config holds none — no run of this source could keep the promise";

/**
 * The pre-flight question a door asks, in the words the worker would use.
 *
 * This is the one part of the file that is not pure: `classifyTarget` resolves the host, and
 * an unresolvable host is a refusal rather than a pass. It lives here because three doors ask
 * it (`POST /api/sources`, `PATCH /api/sources/{id}`, and the run action that mints the job)
 * and one sentence said three times is how a door ends up disagreeing with the minute that
 * runs the same address. The worker does not call this — it calls `assertAllowedTarget`
 * directly above the navigation, which is the shape the egress census reads as coverage.
 */
export async function scrapeTargetProblem(config: unknown): Promise<string | null> {
  const url = scrapeTarget(config);
  if (url === null) return null;
  const verdict = await classifyTarget(url, "config.url");
  return verdict.ok ? null : verdict.reason;
}
