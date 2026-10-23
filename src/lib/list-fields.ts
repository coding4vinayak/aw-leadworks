/**
 * The query-string half of a projected list read (#46).
 *
 * `GET /api/lead-lists/{id}` hands back every member with the whole lead row
 * beside it. Measured against the running app before this round, on a static list
 * filled with 100 imported leads:
 *
 *   GET /api/lead-lists/{id}                    -> 200, 171720 bytes, members=100, 33 keys per lead
 *   GET /api/lead-lists/{id}?fields=email,score -> 200, 171720 bytes, members=100, 33 keys per lead
 *   GET /api/lead-lists/{id}?fields=nonsense    -> 200, 171720 bytes — the whole row, and no refusal
 *   GET /api/lead-lists/{id}?select=email       -> 200, 171720 bytes
 *   GET /api/lead-lists/{id}?include=email      -> 200, 171720 bytes
 *   GET /api/lead-lists/{id}?fields=a&fields=b  -> 200, 171720 bytes
 *   GET /api/lead-lists/{id}?fields=%20email%20 -> 200, 171720 bytes
 *
 * Twelve spellings of "give me less than the row" — `fields`, `select`, `include`,
 * `fields[]`, a repeated `fields`, an empty one, a padded one, a name nobody has —
 * and every one of them answered the same 171,720 bytes. The door does not read its
 * own query string, so a caller asking for an email and a score receives 33 columns
 * per member, and a caller asking for a column the product does not have receives
 * the whole row instead of a refusal. The row is what the campaign needs two of; the
 * other 31 are the wire and the buyer's patience.
 *
 * `LEAD_EXPORT_FIELDS` is the vocabulary this reads its names from, and
 * `LEAD_FIELD_PICK` is the same table the export door validates against, so a
 * projection asked for here is one the exporter could already render — and a name
 * that is not a column is refused there rather than rendered empty.
 *
 * The same list, the same hundred members, after the door started reading its own
 * query string:
 *
 *   (no fields)                                   -> 200, 171720 bytes, 33 keys per lead
 *   ?fields=email                                 -> 200,  19565 bytes,  1 key
 *   ?fields=email,score                           -> 200,  20673 bytes,  2 keys
 *   ?fields=id,email,score,status,company         -> 200,  28097 bytes,  5 keys
 *   ?fields=email&fields=score                    -> 200,  20673 bytes — the two names are both taken
 *   ?fields=score,company,email                   -> 200,  23283 bytes, keys in the order asked
 *   ?fields=email,email                           -> 200,  19565 bytes — one column asked twice is one column
 *   ?fields=%20email%20                           -> 200,  19565 bytes — the padding is not part of the name
 *   ?fields=                                      -> 400 "fields[0] must be a non-empty string"
 *   ?fields=email,,score                          -> 400, naming the empty second entry
 *   ?fields=Email                                 -> 400 — a column is not its own capitalisation
 *   ?fields=nonsense                              -> 400, 676 bytes, naming fields[0] and the vocabulary
 *   ?fields=(300 entries)                         -> 400 "fields holds 300 entries; at most 100"
 *
 * Two members of the first table are not projection answers and stay what they
 * were: `?select=email`, `?include=email` and `?fields[]=email` still deliver
 * 171,720 bytes, because this door reads the parameter named `fields` and nothing
 * else. Inventing three synonyms for one question is how a product ends up with
 * three doors that disagree.
 *
 * The judgement happens before the row is read, so a name nobody has costs a
 * refusal and no bytes — and before the ownership check, which means an
 * unauthenticated `?fields=nonsense` is answered 400 rather than 401. That is not
 * a new leak: `/api/openapi` is served to anyone without a key and already prints
 * every column name this message prints.
 */

import type { LeadExportField } from "./fields";

/**
 * The columns the caller named, or `null` when the request never mentioned
 * `fields` at all — which is a different answer from `?fields=` and must stay
 * different: one is "the row, as always" and the other is a request naming
 * nothing, which the validator refuses rather than guessing at.
 *
 * `getAll` rather than `get`, because `?fields=a&fields=b` names two columns and
 * dropping the second one silently is the same quiet rewrite the export door's
 * `strings` rules already refuse. Splitting happens here and nowhere else, so the
 * engine sees one array and its messages index into the caller's own list.
 */
export function fieldsParam(searchParams: URLSearchParams): string[] | null {
  const raw = searchParams.getAll("fields");
  if (raw.length === 0) return null;
  return raw.flatMap((value) => value.split(","));
}

/**
 * The Prisma `select` that reads exactly those columns, so the projection is decided
 * on the way to the database rather than after the whole row arrives. `id` is not
 * added and not removed: a caller who did not ask for it is not given it, and a lead
 * row a caller cannot see an id on is still the lead they named.
 */
export function leadSelect(values: readonly LeadExportField[]): Partial<Record<LeadExportField, true>> {
  return Object.fromEntries(values.map((field) => [field, true])) as Partial<Record<LeadExportField, true>>;
}
