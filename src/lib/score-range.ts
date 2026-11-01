import { NextResponse } from "next/server";
import { short } from "./validation-engine";

/**
 * One rule for a score bound, spoken by every door that takes one.
 *
 * `Lead.score` is 0–100 by arithmetic (`lead-score.ts`: 17 terms summing to exactly 100), and
 * four places filter on it. Three of them already check the number; the fourth does not, and is
 * documented nowhere. Measured on `origin/main` (`65bd942`) on the running app — `:3401` over
 * `leadworks_r60`, leads at 0, 5, 49, 50, 51, 72, 90, 100 (`/tmp/opencode/r60_measure_b.log`,
 * `r60_measure_c.log`):
 *
 *   GET /api/leads?minScore=50        200 total=5 [100,90,72,51,50]   the honest one
 *   GET /api/leads?minScore=101       200 total=1 [100]               a bound that cannot hold,
 *   GET /api/leads?minScore=500       200 total=1 [100]               quietly become a clamp
 *   GET /api/leads?minScore=51.5      200 total=4 […,51]              the .5 was dropped
 *   GET /api/leads?minScore=1e2       200 total=7 [100…5]             asked 100, read as 1
 *   GET /api/leads?minScore=0x32      200 total=8                     asked 50, got everybody
 *   GET /api/leads?minScore=abc       200 total=8                     a word became no filter
 *   GET /api/leads?minScore=-5        200 total=8                     below the floor, ignored
 *   GET /api/leads?minScore=90&minScore=10  200 total=2               the second word dropped
 *   GET /api/leads?maxScore=1e2       200 total=1 [0]                 asked everything, got the
 *                                                                      worst lead in the table
 *   GET /api/leads?minScore=80&maxScore=20  200 total=0               a contradiction, answered
 *                                                                      as an empty crowd
 *
 * The same two keys inside an export's stored filter are judged later and differently
 * (`POST /api/exports` is a 201 for all of these, and the worker then speaks):
 *
 *   {"filterJson":{"minScore":101}}  → FAILED  filterJson.minScore must be a whole number from 0 to 100
 *   {"filterJson":{"minScore":51.5}} → FAILED  the same sentence
 *   {"filterJson":{"maxScore":"50"}} → FAILED  the same sentence
 *   {"filterJson":{"minScore":-1}}   → FAILED  the same sentence
 *   {"filterJson":{"minScore":50,"maxScore":20}} → COMPLETED records=0 — a delivered empty file
 *
 * and a third door, `POST /api/enrichment-rules`' `conditions.score`, refuses *both* things with
 * yet another grammar: `score.gte must be a whole number — it is 60.5`, `score.gte is 120 and the
 * column is 0-100`, and `score asks for at least 80 and at most 20 — no number is both`.
 *
 * So one number, three grammars, and the busiest door — the lead read — has none: it took the
 * query through `intParam`, whose rule for a page size (an unparseable value falls back to a
 * known-good default) is wrong for a filter, because a default bound is a different crowd and
 * nothing in the answer says so. A page size changes how many rows per page; a bound changes
 * which rows are in the answer at all.
 *
 * The rule lives here now, once. The sentence is the export door's existing one, pinned at
 * `tests/unit/export-format.test.ts:58` and quoted in `readExportFilter`'s own comment as "the
 * lead list route's own vocabulary" — a sentence about a vocabulary this route did not speak until
 * this module made it shared.
 */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/** A whole number, sign allowed, nothing else: no `.5`, no `e`, no `0x`. */
const WHOLE = /^[+-]?\d+$/;

/** The complaint every door gives for a bound it cannot hold, in one set of words. */
const scoreRule = (name: string) => `${name} must be a whole number from ${SCORE_MIN} to ${SCORE_MAX}`;

/**
 * A bound arriving in a JSON body. A number that is whole and inside the column's range, or the
 * sentence — a string is not a number here, because the exporter's own reader honours
 * `typeof … === "number"` and a stored `"50"` would silently widen a file rather than be refused.
 * This is the sentence `tests/unit/export-format.test.ts:58` pins.
 */
export function wholeScoreProblem(name: string, value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX) return null;
  return scoreRule(name);
}

export interface ScoreBound {
  /** The bound to filter by, or null when the caller named none. */
  value: number | null;
  error: null;
}
export interface ScoreBoundError {
  value: null;
  error: NextResponse;
}

/**
 * One score bound off the query string. Three decisions, each the one the other read doors of
 * this app already make about a filter they honour:
 *
 * - **absent or empty names nothing** — `?minScore=` is a form left alone, not a bound of 0;
 * - **padding is not part of the number** — `%2050` and `50%20` are 50, which `intParam` got by
 *   accident through `parseInt` and this states on purpose;
 * - **a name given twice is a question with two answers** — refused by name and count rather than
 *   answered by whichever value `get()` happened to return first.
 *
 * Anything else — `1e2`, `0x32`, `51.5`, `abc`, `101`, `-5` — is a 400 that names the range and
 * echoes the word, because a bound the door could not honour and a crowd that really is empty are
 * two different answers and the caller deserves to hear which one they got.
 */
export function scoreParam(searchParams: URLSearchParams, name: string): ScoreBound | ScoreBoundError {
  const asked = [...new Set(searchParams.getAll(name).map((one) => one.trim()).filter((one) => one !== ""))];
  if (asked.length === 0) return { value: null, error: null };
  if (asked.length > 1) {
    return {
      value: null,
      error: NextResponse.json(
        { error: `${name} was given ${asked.length} numbers (${asked.map(short).join(", ")}); this filter compares ${name} to one of them` },
        { status: 400 },
      ),
    };
  }
  const whole = WHOLE.test(asked[0]) ? Number.parseInt(asked[0], 10) : Number.NaN;
  const problem = Number.isInteger(whole) && whole >= SCORE_MIN && whole <= SCORE_MAX ? null : scoreRule(name);
  if (problem !== null) {
    return { value: null, error: NextResponse.json({ error: `${problem}, got ${short(asked[0])}` }, { status: 400 }) };
  }
  // `-0` is a whole number in range, and the score column holds one zero, not two.
  return { value: whole === 0 ? 0 : whole, error: null };
}

/**
 * A range whose floor is above its ceiling holds no lead that can exist. Answered as `total=0` it
 * is indistinguishable from a crowd that really is empty, which is why `rule-conditions.ts`
 * refuses the same shape for a stored rule; the read door now says it too, naming both numbers.
 */
export function scoreRangeProblem(min: number, max: number): string | null {
  if (min <= max) return null;
  return `minScore ${min} is above maxScore ${max}, and no score is both — this range describes no lead rather than an empty crowd`;
}
