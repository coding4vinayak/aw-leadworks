import { NextResponse } from "next/server";
import type { Field } from "./validation-engine";
import { short } from "./validation-engine";
import { validateBody } from "./validate";

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
 * and `isActive=` with the *inactive* rule — judging the word by comparing it to
 * the quoted `true` is a coercion,
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

export interface FilterText {
  /** The text to filter by, or `null` when the caller said nothing about this column. */
  value: string | null;
  error: null;
}

export interface FilterTextError {
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

/**
 * A text column the read door was asked to filter by, judged by the rule the
 * write door already applies to it.
 *
 * The enum case above is the easy one: `LEAD_STATUSES` is a list of words a
 * column holds, so a word outside it can only be a mistake. A free-text column
 * has no list to check against, and the mistake is in the *shape* — which the
 * write door already refuses, through the field's own entry in `fields.ts`
 * (`email: { kind: "text", nullable: true, format: "email", max: 254 }`).
 * `GET /api/leads?email=` asked none of it. Measured on the running app before
 * this round, in this round's own runtime (`e3fcc16` built in a fresh worktree,
 * served on :3419 over `leadworks_r68`, `/tmp/opencode/r68_press_base.log`) over
 * a workspace holding `bob@x.com, john@x.com, JOHN@X.COM, nina@x.com` and a
 * second tenant holding its own `john@x.com`:
 *
 *   GET /api/leads?email=john@x.com                    200 total=4  — the whole crowd
 *   GET /api/leads?email=JOHN@X.COM                    200 total=4  — the whole crowd
 *   GET /api/leads?email=nobody@x.com                  200 total=4  — indistinguishable from no filter
 *   GET /api/leads?email=not-an-address                200 total=4  — a shape POST /api/leads refuses
 *   GET /api/leads?email=john@x.com&email=nina@x.com   200 total=4
 *   GET /api/leads?email=john@x.com&status=ENRICHED    200 total=1  — nina@x.com
 *
 * The last line is the one that makes this a lie rather than a gap: `status` IS
 * read, so the door applied half of the question and answered with a row whose
 * email is not the email that was asked for. A caller that presses one filter
 * and gets a page filtered by the other has no way to know which of its own
 * conditions the answer obeys — and `total=4` for `?email=nobody@x.com` is the
 * same body as no filter at all, so "nobody by that name" and "you did not ask"
 * are one answer.
 *
 * This is the door the duplicate-refusal points at. #66's PR makes a colliding
 * write answer `{"conflict":{"fields":["email"]}}`, which names this column to a
 * caller that then has no way to ask the read door for it — measured on this
 * build, which does not carry that PR, a duplicate still answers the nameless
 * `{"error":"That Lead already exists in this workspace.","conflict":{"fields":[]}}`
 * (extras leg 12), and `?email=` answered `total=4` either way.
 *
 * Two decisions, both taken from rules this file already runs:
 *
 *  - **The write door's field table is the judge.** The caller passes the
 *    column's own `Field` — `LEAD_EMAIL` in `fields.ts`, the entry
 *    `LEAD_CREATE.email` — and the value goes through `validateBody` with it, so
 *    `?email=not-an-address` is refused with the sentence
 *    `POST /api/leads` already gives for that body, and the 254-character cap is
 *    enforced here too rather than a second, slightly different email rule
 *    being invented for a query string. A column that is not an address gets
 *    its own field passed in; nothing in this file knows what `email` means.
 *  - **Padding, empty and repeated arrive the way `filterParam` treats them.**
 *    `%20john@x.com%20` is the address without its padding; `?email=` names
 *    nothing and returns the whole page; two different values under one name is
 *    a question with two answers and is refused in the same sentence.
 *
 * What it matches: every spelling of the address, because the door that writes one refuses a
 * second spelling. `#66`'s PR — merged as `7ecf030` — made `POST /api/leads` and
 * `PATCH /api/leads/{id}` answer a case-changed collision with a 409 naming the row, and this file
 * then said, of itself, that it "matches the bytes the column holds" on the premise that a second
 * spelling is a second row. That premise is gone: `@@unique([workspaceId, email])` still compares
 * bytes, but no door will write a second one, so a workspace holds one row per address and which
 * case that row is in is decided by whoever wrote it — the one-lead door stores what it was sent,
 * the file door stores it lower-cased. Measured on `ff38306`, over a row stored as `John@X.com`:
 * `?email=john@x.com` was `200 total=0` (the same body as an address nobody has) while
 * `POST {email:"john@x.com"}` was `409 "already exists in this workspace … with the case changed"`.
 * So the filter is `emailFold()` from `lead-email.ts` — the same rule `csv-import.ts` looks up with
 * and the two write doors refuse a second spelling with — and `GET /api/leads?email=` now answers
 * the question the write door answers.
 *
 * Two things this costs, both already being paid elsewhere in this app. The fold goes through
 * `ILIKE`, whose `%` and `_` are wildcards; `emailFold()` escapes them, and that escape is not
 * decoration — the fold's first cut without it answered `?email=%@x.com` with every `@x.com` row
 * (`total=9` on this round's seeded table), `?email=a_c@x.com` with `abc@x.com`, and
 * `?email=50%@x.com` with two rows, the stored `50%@x.com` beside its neighbour `50Z@x.com`.
 * Escaped, those three legs answer `0`, `0` and the one row, which is what "matches the address"
 * means. And the fold is no longer served by the composite index, `workspaceId` prefix included:
 * measured on a 30,000-row scratch table with the same unique index, the byte-exact predicate is an
 * `Index Only Scan` and the folded one a `Seq Scan` filtered on both columns. That is the cost the
 * file door has paid since it folded, and the write doors pay per address they take.
 */
export function textFilterParam(
  searchParams: URLSearchParams,
  name: string,
  field: Field,
): FilterText | FilterTextError {
  const asked = [...new Set(searchParams.getAll(name).map((one) => one.trim()).filter((one) => one !== ""))];
  if (asked.length === 0) return { value: null, error: null };
  if (asked.length > 1) {
    return {
      value: null,
      error: bad(`${name} was given ${asked.length} words (${asked.map(short).join(", ")}); this filter compares ${name} to one of them`),
    };
  }
  const input = validateBody({ [name]: asked[0] }, { [name]: field });
  if (!input.ok) return { value: null, error: input.error };
  return { value: input.data[name] as string, error: null };
}

