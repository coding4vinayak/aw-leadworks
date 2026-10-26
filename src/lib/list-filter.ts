import { NextResponse } from "next/server";
import { short } from "./validation-engine";

/**
 * The word a read door filters by, checked against the column's own vocabulary.
 *
 * `enums.ts` declares these sets and the write routes validate against them, so
 * `PATCH /api/leads/{id} {status:"DONE"}` is a 400 that names every word the
 * column holds. The read doors never joined in. Measured on the running app
 * before this round, in this round's own runtime over a workspace of six leads —
 * one per `Lead.status`, five queued jobs and one completed CSV export, so the
 * export door's `PROCESSING` and `PENDING` rows below were answering a table that
 * genuinely holds neither rather than refusing the word:
 *
 *   GET /api/leads?status=NEW                       200 total=1
 *   GET /api/leads?status=new                       200 total=0   — no refusal, an empty page
 *   GET /api/leads?status=NEW%20                    200 total=0   — the padding is the whole word
 *   GET /api/leads?status=NEW,ENRICHED              200 total=0   — a comma is not an OR
 *   GET /api/leads?status=ACTIVE                    200 total=0   — a word no column holds
 *   GET /api/leads?status=PROCESSING                200 total=0   — an Export word, asked of a Lead
 *   GET /api/leads?status=null                      200 total=0
 *   GET /api/leads?status=NEW&status=ENRICHED       200 total=1   — one of the two, silently
 *   GET /api/leads?status=                          200 total=6   — nothing named, everything returned
 *   GET /api/jobs?type=scrape                       200 total=0   (type=SCRAPE: total=1)
 *   GET /api/jobs?status=DONE                       200 total=0   — the value PATCH refuses by name
 *   GET /api/exports?status=RUNNING                 200 total=0   — a Job word, asked of an Export
 *   GET /api/exports?status=PROCESSING              200 total=0   — a real Export word, declared nowhere
 *
 * An empty page and a mistyped filter are the same answer, and the caller has no
 * way to tell them apart. That is the same failure `enums.ts` opens with — a word
 * outside the set is invisible to every comparison the code makes — arriving from
 * the other side: not a row nobody can find, but a question nobody can answer.
 *
 * It is not that these doors read no query string. The leads door projects with
 * `?fields=` and refuses `?fields=Email` and `?fields=nonsense` by name (see
 * `list-fields.ts`), and `?page=abc` falls back rather than throwing (see
 * `pagination.ts`). `status`, `type` and the rest of the vocabulary filters were
 * the parameters left unchecked, and the refusal this file adds is the sentence
 * the write routes already speak — `${name} must be one of A | B | C, got "x"`.
 *
 * Three decisions, each taken to match a rule this app already runs:
 *
 *  - **Padding is not part of the word.** `?fields=%20email%20` projects `email`;
 *    `stringList` trims every list entry; `short()` trims before quoting. So
 *    `?status=%20NEW` is `NEW`, and a value that is only padding names nothing.
 *  - **An empty value names nothing.** `?status=` is an absent `status`, and both
 *    return the whole page. It stays that way because a form whose select has no
 *    choice sends exactly that, and "no opinion" is a real request. Contrast
 *    `?fields=`, which is refused: an empty *list* of columns is a projection of
 *    nothing, which is not a thing this API can do.
 *  - **A word repeated is a question with two answers.** `?fields=a&fields=b`
 *    names two columns and both are taken, because a projection holds what it was
 *    given. A status filter compares one column to one word, so the second value
 *    cannot also be honoured and dropping it silently is the quiet rewrite
 *    `fieldsParam`'s comment already refuses. Same word twice is one word.
 *
 * What this file does *not* touch: `GET /api/sources?isActive=` and
 * `GET /api/enrichment-rules?isActive=`, measured against one active and one
 * inactive rule, answer `isActive=yes`, `isActive=TRUE`, `isActive=1`, `isActive=no`
 * and `isActive=` with the *inactive* rule — `isActive === "true"` is a coercion,
 * not a vocabulary, and its wrong answer is a page of the other state rather than
 * an empty one. That is a second defect with its own blast radius (a `1` is a
 * plausible way to ask for true), and it is left for its own round.
 */

export interface FilterWord {
  /** The word to filter by, or `null` when the caller said nothing about this column. */
  value: string | null;
  error: null;
}

export interface FilterWordError {
  value: null;
  error: NextResponse;
}

/**
 * Why this word cannot name a value of the column, in the same sentence the write
 * routes use, or `null` when it can. Split out because the same word arrives two
 * ways: in a query string here, and inside an export's `filterJson` there.
 */
export function filterWordProblem(name: string, value: string, words: readonly string[]): string | null {
  return words.includes(value) ? null : `${name} must be one of ${words.join(" | ")}, got ${short(value)}`;
}

/**
 * The one word a read door was asked to filter by, or the refusal.
 *
 * `getAll` rather than `get`, for the same reason `fieldsParam` gives: `get()`
 * returns the first and the rest of the caller's request disappears.
 */
export function filterParam(
  searchParams: URLSearchParams,
  name: string,
  words: readonly string[],
): FilterWord | FilterWordError {
  const asked = [...new Set(searchParams.getAll(name).map((one) => one.trim()).filter((one) => one !== ""))];
  if (asked.length === 0) return { value: null, error: null };
  if (asked.length > 1) {
    return {
      value: null,
      error: bad(`${name} was given ${asked.length} words (${asked.map(short).join(", ")}); this filter compares ${name} to one of them`),
    };
  }
  const problem = filterWordProblem(name, asked[0], words);
  if (problem !== null) return { value: null, error: bad(problem) };
  return { value: asked[0], error: null };
}

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
