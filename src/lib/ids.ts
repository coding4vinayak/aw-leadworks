import { NextResponse } from "next/server";
import { stringList } from "./validate";
import { short } from "./validation-engine";

/**
 * A caller-supplied list is input, not a fact, and it has to be checked before
 * it reaches Prisma or a later reader. Neither failure shape is informative
 * once it gets there. Measured on POST /api/leads, before any of this existed:
 *
 *   listIds: ["nope"]        P2003 "Foreign key constraint violated"  -> 500
 *   listIds: "abc"           TypeError: listIds.map is not a function -> 500
 *   listIds: [42]            PrismaClientValidationError              -> 500
 *   listIds: [id, id]        409 "a Lead with this listId + leadId
 *                            already exists" — about a lead that did not
 *                            exist yet
 *   listIds: {a: 1}          201, with no membership written at all, because
 *                            `?.length` is undefined on an object: a lead
 *                            outside every list the caller named, silently
 *                            missing every campaign keyed to those lists
 *   technologies: 42         201, then a 500 inside mergeLeads later:
 *                            `src/lib/dedupe.ts` spreads it
 *
 * withAuth maps P2002 and nothing else, so the first three left as 500 — the
 * one status a correct client retries, against a request that will fail
 * identically forever.
 *
 * Abetanalytics' dashboards route and snapshots' `typeof metricId !== "string"`
 * guard already do this inline; this is the same rule in one place for the two
 * apps that take a list.
 */
export interface IdList {
  /** Deduplicated, order-preserving; empty when the caller named nothing. */
  values: string[];
  error: null;
}
export interface IdListError {
  values: null;
  error: NextResponse;
}

/**
 * `max` bounds one request's fan-out: an unbounded list turns a single POST
 * into thousands of membership rows, and the page-size lesson from `limit` is
 * that a cap is the only thing a hostile or buggy client cannot argue with.
 *
 * The parse itself is `stringList` in `src/lib/validate.ts`, so an array of
 * strings is one rule whether it arrives as `listIds`, `tags` or `providers` —
 * which also means entries are trimmed here as they are there: `" a@b.co "` and
 * `" cmu123 "` are the value without its padding, not a value with spaces in it.
 */
export function asStrings(value: unknown, name: string, max = 100): IdList | IdListError {
  // Absent and empty mean the same thing here: nothing named. `null` reaches
  // us from JSON, `undefined` from a body that never mentioned the field, and
  // both must stay the 201 they are today.
  if (value === undefined || value === null) return { values: [], error: null };
  const parsed = stringList(value, name, { max });
  if (!parsed.ok) return { values: null, error: parsed.error };
  return { values: parsed.values, error: null };
}

/**
 * 422, not 404: the request is well-formed and the record it creates is fine —
 * one of the ids it points at is not. Naming them is the whole point; "a list
 * was not found" makes a caller who sent twenty ids guess which.
 */
export function unknownIdsError(name: string, missing: string[]): NextResponse {
  const shown = missing.slice(0, 5);
  const more = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : "";
  return NextResponse.json(
    { error: `${name} holds ${missing.length} id${missing.length === 1 ? "" : "s"} this workspace does not have: ${shown.join(", ")}${more}`, unknownIds: missing },
    { status: 422 },
  );
}

/**
 * The singular of `unknownIdsError`, for the scalar foreign keys that name one
 * row instead of holding a list of them: `Job.sourceId`, `Export.profileId`.
 * Measured, an unresolvable one left as P2003 ("Foreign key constraint
 * violated", no field named) — a 500 for what is really a typo in one field.
 * Same status and same machine-readable `unknownIds`, so one client can handle
 * both shapes without telling a list from a reference.
 */
export function unknownIdError(name: string, id: string): NextResponse {
  return NextResponse.json({ error: `${name} is not an id this workspace has: ${id}`, unknownIds: [id] }, { status: 422 });
}

/**
 * Ids in `wanted` that the database did not return, in the caller's order.
 */
export function missingIds(wanted: string[], found: { id: string }[]): string[] {
  const have = new Set(found.map((f) => f.id));
  return wanted.filter((id) => !have.has(id));
}

/**
 * A read door that filters on a row the caller names has to resolve that name before it
 * filters, or "no rows" stops meaning "this crowd is empty" and starts meaning "I could
 * not read your filter". Measured on `origin/main` (`65bd942`, `:3381` over `leadworks_r58`,
 * three leads on `list-alpha`, two jobs on `src-alpha`, two exports on `profile-alpha`, a
 * second tenant holding `list-foreign` / `src-foreign` / `profile-foreign`):
 *
 *   GET /api/leads?listId=<list-beta, which is real and empty>   200 total=0   honest
 *   GET /api/leads?listId=nope                                    200 total=0   indistinguishable
 *   GET /api/leads?listId=<another tenant's list>                 200 total=0   indistinguishable
 *   GET /api/leads?listId=%20<real id>                            200 total=0   the padding became the id
 *   GET /api/leads?listId=<a>&listId=<b>                          200 total=3   one of the two, silently
 *
 * `jobs?sourceId=` and `exports?profileId=` answered the same way on their own columns, and
 * every one of those typos is a 422 at the matching write door on the same build:
 * `sourceId is not an id this workspace has: nope`. So the door that writes the reference
 * checks it and the door that reads by it does not.
 */
export interface IdFilter {
  /** The one id to filter by, or null when the caller named none. */
  id: string | null;
  error: null;
}
export interface IdFilterError {
  id: null;
  error: NextResponse;
}

/**
 * The reading half of `idFilterParam`, on its own: a name the caller spelled in a query
 * string, trimmed, and refused when the same name is spelled more than once with different
 * answers. Split out because a door that *fetches* the row an id names needs this and does
 * not need the resolution step: `GET /api/ai/explain-lead?id=` scopes its own lookup, so a
 * name this workspace does not hold is honestly `404 lead not found` — the answer
 * `GET /api/leads/{id}` gives for the same shape — and turning that into the 422 an
 * unresolvable *filter* earns would re-decide a scoping rule that is not this one's to move.
 *
 * Measured on the running app (`15e100e`, `:3431` over `leadworks_r72`, tenant A holding
 * `ld_r72_ana` score 40 and `ld_r72_bo` score 71, tenant B holding `ld_r72_cy` score 88 —
 * `/tmp/opencode/r72_press_ab.log`): `?id=ld_r72_ana` answered `200 score=40`;
 * `?id=%20ld_r72_ana%20`, `%20ld_r72_ana` and `ld_r72_ana%20` each answered
 * **`404 lead not found` for a row this workspace holds**; and
 * `?id=ld_r72_ana&id=ld_r72_bo` answered **`200 score=40` in 925 bytes — byte-identical to
 * the control**, the second row dropped without a word. On that same build
 * `GET /api/leads?listId=%20lst_r72_a%20` returned the two leads on the trimmed list and
 * `?listId=lst_r72_a&listId=nope` was a 400 naming both ids: one app, two answers for one
 * spelling, because only one of the doors read its name through this rule.
 */
export interface OneId {
  /** The id to read, trimmed, or null when the caller named none. */
  value: string | null;
  error: null;
}
export interface OneIdError {
  value: null;
  error: NextResponse;
}

export function oneIdParam(searchParams: URLSearchParams, name: string): OneId | OneIdError {
  const asked = [...new Set(searchParams.getAll(name).map((one) => one.trim()).filter((one) => one !== ""))];
  if (asked.length === 0) return { value: null, error: null };
  if (asked.length > 1) {
    return {
      value: null,
      error: NextResponse.json(
        { error: `${name} was given ${asked.length} ids (${asked.map(short).join(", ")}); this filter compares ${name} to one of them` },
        { status: 400 },
      ),
    };
  }
  return { value: asked[0], error: null };
}

/**
 * One caller-named id, trimmed, and resolved against this workspace before the route
 * builds its `where`. The three decisions, each taken to match a rule the app already runs:
 *
 * - **absent or empty names nothing** — `?listId=` is a form field the user left alone, the
 *   same reading `GET /api/exports?status=` and `POST /api/jobs {sourceId: null}` already get.
 * - **padding is not part of the id** — `stringList` trims the entries of `listIds`, and the
 *   write door that takes a scalar takes the trimmed value; a read door that did not trim
 *   would answer an empty table for an id that exists.
 * - **a name given twice is a question with two answers** — `getAll` is read, deduplicated and
 *   refused above one, so the page a caller gets is the page they asked for.
 *
 * An id that does not resolve here gets `unknownIdError` — the write door's own 422, same
 * sentence and same `unknownIds`, so one client handles a typo in a query string and a typo
 * in a body identically. Another tenant's row answers through the same branch as a row that
 * exists nowhere: the lookup is scoped, so a foreign id names nothing about its owner.
 */
export async function idFilterParam(
  searchParams: URLSearchParams,
  name: string,
  exists: (id: string) => Promise<boolean>,
): Promise<IdFilter | IdFilterError> {
  const asked = oneIdParam(searchParams, name);
  if (asked.error) return { id: null, error: asked.error };
  if (asked.value === null) return { id: null, error: null };
  if (!(await exists(asked.value))) return { id: null, error: unknownIdError(name, asked.value) };
  return { id: asked.value, error: null };
}
