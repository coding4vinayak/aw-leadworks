import { NextResponse } from "next/server";
import { stringList } from "./validate";

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
