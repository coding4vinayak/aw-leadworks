/**
 * The word half of a query string, judged against the actions one door takes (#75).
 *
 * Six write doors act on what `?action=` says, and all six read it with
 * `searchParams.get("action")` — the one read in this app that treats a caller's word as raw
 * bytes. Measured on the running app before anything was written (`ff38306` built in a fresh
 * worktree, `:3437` over this session's own `leadworks_r75`, private Redis 6420, two workspaces,
 * keys in `0600` files printed nowhere; `/tmp/opencode/r75_press_ab.log`):
 *
 *   POST /api/sources/src_r75_notarget?action=run              400 134  "a scrape navigates to
 *                                                                   the address in config.url…"
 *   POST /api/sources/src_r75_notarget?action=%20run           400  26  "Unknown action"
 *   POST /api/sources/src_r75_notarget?action=run%20           400  26  "Unknown action"
 *   POST /api/sources/src_r75_notarget?action=%09run           400  26  "Unknown action"
 *   POST /api/sources/src_r75_notarget?action=RUN              400  26  "Unknown action"
 *   POST /api/sources/src_r75_notarget?action=run&action=cancel
 *                                                              400 134  — `cancel` dropped
 *   POST /api/jobs/job_r75_pending?action=cancel&action=retry   — the word that is served wins,
 *                                                                   and this pair WRITES
 *   POST /api/exports/exp_r75_file?action=download             200  52  {"downloadUrl":…}
 *   POST /api/exports/exp_r75_file?action=retry&action=download 400  41  "Can only retry failed
 *                                                                   exports" — `download` dropped
 *   GET  /api/openapi   /api/exports/{id} post action → "retry — the only action."
 *
 * So `?action=%20run` is "Unknown action" for a row this workspace holds and a word this door
 * takes, and one app answers the same two words two ways depending on which one the client
 * happened to type first: `?action=retry&action=download` retries and `?action=download&
 * action=retry` downloads. The refusal that a caller is most likely to hit — the opaque
 * `Unknown action` — names neither the word they sent nor the words that would have worked,
 * while the map on the same build claims `exports/{id}` takes one action and that door answers
 * `200` with a `downloadUrl` for another.
 *
 * The reading rule already exists in this app, three times over, and none of it is applied here:
 * `boolParam` (`bool-word.ts`) trims, drops an empty value, treats a word repeated as one word
 * and refuses a key given two different words; `idFilterParam` (`ids.ts`) does the same to an id;
 * the projection helpers (`short()`, `stringList`) trim before they quote. The doors that take a
 * word are the last places in `src/` where a query-string value is compared to a literal
 * without that reading.
 *
 * Three decisions, each taken to match a rule this app already runs:
 *
 *  - **Padding is not part of the word.** `?isActive=%20true` is `true` and `?fields=%20email%20`
 *    projects `email`, so `?action=%20run` is `run`. Case is *not* padding: `?isActive=TRUE` is
 *    refused, so `?action=RUN` is refused too — with a sentence that says what would have worked.
 *  - **An empty value names no action.** `?action=` and `?action` name nothing. A boolean column
 *    can fall back to its `@default`; a door that has to do something cannot, so this is a
 *    refusal rather than the `null` `boolParam` returns, and it is the refusal the door already
 *    made with `400` — the status does not move.
 *  - **A word repeated is a question with two answers.** `getAll` is read, trimmed, emptied,
 *    deduplicated and refused above one. The same word twice is one word, so
 *    `?action=download&action=download` still downloads.
 *
 * Each door's refusal is answered where that door answered `Unknown action` today, so no word
 * refusal jumps an ownership check that sits above it: `jobs`, `exports` and `lead-lists` look
 * the row up and assert the workspace first, `sources`, `leads` and `enrichment-rules` judge the
 * word first, and both orders keep every byte of their existing 404s.
 */

import { NextResponse } from "next/server";
import { short } from "./validation-engine";

/** `POST /api/sources/{id}` — one word, and the map says so. */
export const SOURCE_ACTIONS = ["run"] as const;
/** `POST /api/jobs/{id}` — resume a stopped job, or stop one that has not finished. */
export const JOB_ACTIONS = ["retry", "cancel"] as const;
/** `POST /api/exports/{id}` — the link, or the re-run. `download` is served and was not in the map. */
export const EXPORT_ACTIONS = ["download", "retry"] as const;
/** `POST /api/leads/{id}` — run the rules over this lead, or put it on one list. */
export const LEAD_ACTIONS = ["enrich", "add-to-list"] as const;
/** `POST /api/lead-lists/{id}` — move rows in or out, or re-run the filter a dynamic list holds. */
export const LEAD_LIST_ACTIONS = ["add-leads", "remove-leads", "refresh"] as const;
/** `POST /api/enrichment-rules/{id}` — one word, and the map says so. */
export const RULE_ACTIONS = ["run"] as const;

export interface ActionWord {
  /** The one action to take, or `null` when the caller's spelling is refused. */
  action: string | null;
  error: null;
}

export interface ActionWordError {
  action: null;
  error: NextResponse;
}

/**
 * Why this spelling cannot name one of this door's actions, or `null` when it can. Split out
 * because the six doors want the same sentence over their own vocabulary and a test wants to
 * read it without a request — the shape `boolWordProblem` already has.
 */
export function actionWordProblem(asked: readonly string[], allowed: readonly string[]): string | null {
  if (asked.length === 0) return `action must be one of ${allowed.join(" | ")}, got nothing`;
  if (asked.length > 1) {
    return `action was given ${asked.length} words (${asked.map(short).join(", ")}); this door acts on one of them`;
  }
  if (allowed.includes(asked[0])) return null;
  return `action must be one of ${allowed.join(" | ")}, got ${short(asked[0])}`;
}

/**
 * The one action this door was asked to take, or the refusal.
 *
 * `getAll` rather than `get`, for the reason the projection helpers and `boolParam` give: `get()`
 * returns the first value and the rest of the caller's request disappears — which here is the
 * difference between retrying a job and cancelling it.
 */
export function actionParam(searchParams: URLSearchParams, allowed: readonly string[]): ActionWord | ActionWordError {
  const asked = [...new Set(searchParams.getAll("action").map((one) => one.trim()).filter((one) => one !== ""))];
  const problem = actionWordProblem(asked, allowed);
  if (problem !== null) {
    return { action: null, error: NextResponse.json({ error: problem }, { status: 400 }) };
  }
  return { action: asked[0], error: null };
}
