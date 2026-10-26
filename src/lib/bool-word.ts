/**
 * The boolean half of a query string, judged against the two words it has
 * (#57).
 *
 * Two read doors filter by a `Boolean` column, and both did it with the same
 * line — `where.isActive = isActive === "true"` — which is not a vocabulary but
 * a coercion with one accepted spelling. Measured on the running app before this
 * round, over three active sources and two paused ones, then two active rules and
 * one paused one (`/tmp/opencode/r57_measure.log`, `r57_measure_c.log`):
 *
 *   GET /api/openapi            "isActive :: Only the ones running (1) or paused (0)."
 *
 *   GET /api/sources                     200 total=5   — everything
 *   GET /api/sources?isActive=true       200 total=3   [src-active-1..3]
 *   GET /api/sources?isActive=false      200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=1          200 total=2   [src-paused-1..2]  ← the documented word for "running"
 *   GET /api/sources?isActive=0          200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=TRUE       200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=yes        200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=no         200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=%20true    200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=true%20    200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=           200 total=2   [src-paused-1..2]
 *   GET /api/sources?isActive=true&isActive=false
 *                                        200 total=3   — one of the two, silently
 *
 * and the rules door answered the same way over its own three rows. So the value
 * this product's own contract tells a caller to send for "running" returns the
 * paused crowd, the value for "paused" returns the paused crowd too — the two
 * documented words are indistinguishable — and every other spelling lands on
 * `false`. `scheduler.ts:76`, `scheduler.ts:106`, `scheduler.ts:147` and
 * `enrichment.ts:349` all sweep `isActive: true`, so "the ones running" is
 * precisely the set the door hides from a caller who believed the contract.
 *
 * The write doors already refuse this shape of silence. `PATCH /api/sources/{id}
 * {"isActive":"1"}` is
 *
 *   400 isActive must be true or false, got a string — send it unquoted
 *
 * (and the same for `1`, `"true"`, `"yes"`, `"no"`; `true` is a 200), because
 * `validation-engine.ts`'s `bool` kind exists precisely to stop `Boolean(isActive)`
 * turning `"no"` and `42` into `true`. The read doors are the last two places in
 * `src/` where a caller's word for a boolean is judged by comparison to one
 * literal, and the fix is to give them the set they were missing.
 *
 * Three decisions, each taken to match a rule this app already runs at a read
 * door:
 *
 *  - **Padding is not part of the word.** `?fields=%20email%20` projects `email`
 *    and `short()` trims before quoting, so `?isActive=%20true` is `true`.
 *  - **An empty value names nothing.** `?isActive=` is an absent `isActive` and
 *    both return the whole table. Today it returns the paused crowd, which is the
 *    one answer a form with an unselected checkbox should never get. The column's
 *    own `@default` is `true`, so "no opinion" is not the same question as
 *    "paused" — the door cannot tell the caller which crowd it chose.
 *  - **A word repeated is a question with two answers.** `?isActive=true&
 *    isActive=false` cannot be honoured by one column comparison, and picking the
 *    first silently is the rewrite the projection helpers refuse. Same word twice
 *    is one word.
 *
 * `1` and `0` are refused rather than folded in, and the contract text that
 * recommended them is corrected in the same commit. They are the digits a JSON
 * body would be told off for sending, and this API's JSON body takes `true` and
 * `false` unquoted — a read door accepting a word its write door refuses is two
 * vocabularies for one column, which is how the sentence above got written in the
 * first place.
 */

import { NextResponse } from "next/server";
import { short } from "./validation-engine";

/** The words a boolean query parameter holds. Nothing else is a boolean. */
export const BOOL_WORDS = ["true", "false"] as const;

export interface BoolWord {
  /** The state to filter by, or `null` when the caller said nothing about this column. */
  value: boolean | null;
  error: null;
}

export interface BoolWordError {
  value: null;
  error: NextResponse;
}

/**
 * Why this word cannot name a value of a boolean column, or `null` when it can.
 * Split out because the doors want the same sentence and a test wants to read it
 * without a request.
 */
export function boolWordProblem(name: string, value: string): string | null {
  if (value === "true" || value === "false") return null;
  return `${name} must be one of ${BOOL_WORDS.join(" | ")}, got ${short(value)}`;
}

/**
 * The one boolean a read door was asked to filter by, or the refusal.
 *
 * `getAll` rather than `get`, for the reason the projection helpers give: `get()`
 * returns the first value and the rest of the caller's request disappears.
 */
export function boolParam(searchParams: URLSearchParams, name: string): BoolWord | BoolWordError {
  const asked = [...new Set(searchParams.getAll(name).map((one) => one.trim()).filter((one) => one !== ""))];
  if (asked.length === 0) return { value: null, error: null };
  if (asked.length > 1) {
    return {
      value: null,
      error: NextResponse.json(
        { error: `${name} was given ${asked.length} words (${asked.map(short).join(", ")}); this filter compares ${name} to one of them` },
        { status: 400 },
      ),
    };
  }
  const problem = boolWordProblem(name, asked[0]);
  if (problem !== null) return { value: null, error: NextResponse.json({ error: problem }, { status: 400 }) };
  return { value: asked[0] === "true", error: null };
}
