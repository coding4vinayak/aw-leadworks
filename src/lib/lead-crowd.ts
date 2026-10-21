/**
 * The leads a background job was told to work on.
 *
 * Two doors queue a job that means specific people: `VALIDATE` with `leadIds`, and
 * `POST /api/leads/{id}?action=enrich`, which names one in its URL. Before this
 * module both were the same shape of lie — the id arrived, the worker selected
 * `where: { workspaceId }` and walked the whole workspace, so one click on one
 * lead's row was a sweep over every stranger in the list (measured: `processed=20`
 * for a request naming 1 of 20).
 *
 * A job's `config` is a Json column its caller wrote, so this reads it as the
 * untrusted thing it is and the callers keep their own workspace scope whichever
 * way the answer goes: a named crowd is `id: { in: [...] }` *beside*
 * `workspaceId`, never instead of it, which is what makes `leadIds:
 * ["one of mine", "one of theirs"]` reach exactly one row and no other tenant's.
 */

/**
 * The ids a job was named, or `null` for "not named — take the rule's crowd, or
 * the workspace's default". Anything that is not a list of non-blank strings is
 * not named: a bare string, an object, an empty array and an array of numbers all
 * mean the same nothing, and are answered the way an unscoped job always was
 * rather than crashed into a `WHERE IN ()`. Entries are trimmed and folded the way
 * a provider list is, because `[" lead_1 ", "lead_1"]` is one person named twice,
 * not two people.
 */
export function namedLeads(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const one = entry.trim();
    if (one !== "" && !ids.includes(one)) ids.push(one);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * The `where` for a job that both names people and carries a rule's conditions:
 * the two are intersected, so a named id that does not satisfy the declaration is
 * not visited. Filtering can only narrow — this never widens a rule's crowd.
 */
export function crowdWhere(base: Record<string, unknown>, crowd: string[] | null): Record<string, unknown> {
  return crowd === null ? base : { ...base, id: { in: crowd } };
}
