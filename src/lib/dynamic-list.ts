import { CONDITION_KEYS, conditionsProblem, normalizeConditions, type RuleConditions } from "./rule-conditions";

/**
 * `LeadList.isDynamic` and `LeadList.filterJson`, read as the two columns' own comments promise.
 *
 * `prisma/schema.prisma` spells `filterJson Json? // Filter criteria for dynamic lists` beside
 * `isDynamic Boolean @default(false)`, and both list doors sell them — `LEAD_LIST_CREATE` and
 * `LEAD_LIST_PATCH` carry `isDynamic: { kind: "bool" }` and `filterJson: { kind: "json" }`.
 * Measured on the running app before this file existed, with the crowd already in the workspace:
 *
 * ```
 *   POST /api/lead-lists {isDynamic:true, filterJson:{status:"QUALIFIED"}} -> 201 (both stored)
 *   GET  /api/lead-lists/{id}                                              -> members 0
 *   POST /api/lead-lists/{id}?action=refresh {isDynamic:true}             -> 200
 *        {"ok":true,"message":"Dynamic list refresh not fully implemented"}
 *   GET  the same list again                                               -> members 0
 * ```
 *
 * The door answered `ok` and printed its own admission in the same body. Three more halves of the
 * same shape were measured in the same breath:
 *
 * - **The flag was taken from the request, not from the row.** The branch was
 *   `if (action === "refresh" && body.isDynamic)`, so a dynamic list refreshed *without* the flag
 *   in the body answered `400 "Unknown action"`, and a list whose `isDynamic` is `false` answered
 *   the same 200-message as soon as a caller typed `isDynamic: true` at it. The column was not
 *   consulted anywhere in `src/`.
 * - **`kind: "json"` proves the shape of a blob and nothing about what it means.**
 *   `filterJson: 42` and `filterJson: "hello"` are refused (`must be an object or an array`), while
 *   `filterJson: { a: 1 }` and `filterJson: []` are **201** — a key no `Lead` column can hold, and
 *   a filter that names nothing at all. A list can be sold as dynamic with nothing to select on.
 * - **The edit door would overwrite a working filter with an unreadable one**:
 *   `PATCH {filterJson:{status:"NEW",nonsense:1}}` answered 200 with that blob stored.
 *
 * So this file decides three things and queries nothing: what a list's filter is allowed to say,
 * how a refresh's membership is derived from it, and what a door answers when either half is not
 * there. The *vocabulary* is not invented here — it is the one `lib/rule-conditions.ts` already
 * reads for `EnrichmentRule.conditions` (`CONDITION_KEYS`: `status`, `seniority`, `score`, `tags`,
 * each validated against the words `schema.prisma` spells for the `Lead` columns). A list and a
 * rule that declare the same filter must select the same crowd, because two grammars for "which
 * leads" is two readers that can disagree, which is the bug this fleet keeps finding.
 */

/** How a filter that a list cannot be refreshed from reads, or the filter itself. */
export interface ListFilterRead {
  filter: RuleConditions;
  problem: string | null;
}

/**
 * The stored or incoming `filterJson`, as the grammar it either is or is not.
 *
 * Three refusals, and the third is the one that makes a list read differently from a rule:
 *
 * - **Nothing to re-run.** A dynamic list with no `filterJson` is refused rather than defaulted.
 *   `readStoredConditions` gives a rule that declares nothing the historical `NEW | ENRICHED` set,
 *   and that is right *for a rule*: stored rows cannot be re-interpreted into something broader
 *   than they were, and enrichment's blast radius is a column on people's rows. A list has no
 *   such history to protect — there is no stored dynamic list to preserve (`SELECT count(*) FROM
 *   "LeadList"` was 0 when this was measured) — and "every lead in the workspace" is not what
 *   `// Filter criteria for dynamic lists` says the column is for. A caller who wants every lead
 *   adds them; a caller who wants a crowd declares it.
 * - **A blob no lead can be.** Delegated to `conditionsProblem`, with the subject said as a list
 *   so the sentence names what the caller is editing. Unknown keys, empty value lists, scores
 *   outside 0-100, `gte > lte`: all refused here at the door and again at the refresh, because the
 *   column is `Json` and anything can already be in it.
 * - **A filter that says nothing about anybody.** `{}` and `{ tags: [] }` normalize to no keys at
 *   all, which through `leadWhere` would be `where: { AND: [{ workspaceId }] }` — every lead in
 *   the workspace, selected by a declaration that mentioned none of them.
 */
export function readListFilter(value: unknown): ListFilterRead {
  if (value === undefined || value === null) {
    return { filter: {}, problem: "this list declares no filter to re-run — a dynamic list is one that says which leads belong in it" };
  }
  const problem = conditionsProblem(value, "a dynamic list");
  if (problem !== null) return { filter: {}, problem };
  const filter = normalizeConditions(value);
  if (Object.keys(filter).length === 0) {
    return { filter: {}, problem: `this filter says nothing about any lead — declare at least one of ${CONDITION_KEYS.join(", ")}` };
  }
  return { filter, problem: null };
}

/** What one refresh does to a list's membership. */
export interface ListRefreshPlan {
  /** Matched now, in the list already — the rows a refresh leaves alone. */
  keep: string[];
  /** Matched now, not in the list — the rows it adds. */
  add: string[];
  /** In the list, no longer matched — the rows it removes. */
  remove: string[];
  /** How many leads the filter names in this workspace, whether or not they were already in. */
  matched: number;
}

/**
 * The membership diff a refresh writes, from the two sets of ids the caller reads.
 *
 * The set difference is the whole decision, and it is the half that says what a dynamic list
 * *is*: membership is derived from the filter, so a lead the filter no longer names leaves. That
 * includes one an operator hand-added with `?action=add-leads` — a static list's members are what
 * somebody put in it, a dynamic list's are what its filter names, and a list that only ever grew
 * would be a filter in the first half of its life and a pile in the second.
 *
 * Every list is sorted, so the write order and the reported counts are the same for the same two
 * sets: two refreshes that find the same crowd produce the same diff, byte for byte.
 */
export function planListRefresh(currentLeadIds: Iterable<string>, matchedLeadIds: Iterable<string>): ListRefreshPlan {
  const current = new Set(currentLeadIds);
  const matched = new Set(matchedLeadIds);
  const keep: string[] = [];
  const add: string[] = [];
  for (const id of matched) (current.has(id) ? keep : add).push(id);
  const remove: string[] = [];
  for (const id of current) if (!matched.has(id)) remove.push(id);
  const sorted = (ids: string[]) => [...ids].sort();
  return { keep: sorted(keep), add: sorted(add), remove: sorted(remove), matched: matched.size };
}

/** What the refresh door may do, and if not, the answer it owes. */
export interface ListRefreshAsk {
  ok: boolean;
  http: number;
  error: string | null;
}

/**
 * The door's own first two questions, before any lead is read.
 *
 * `rowIsDynamic` comes from **the row**, not the request body — the flag a caller types is not the
 * column the schema spells, and obeying the body was how a static list got a 200 for a refresh of
 * a filter it does not have. `filterProblem` is `readListFilter`'s verdict on the stored column.
 *
 * The two refusals are different statuses because they are different facts. A list that is not
 * dynamic is a **400**: the request asked for something this row is not, and the fix is on the
 * caller's side (add leads by hand, or make the list dynamic). A dynamic list whose stored filter
 * cannot be read is a **409** — the request is perfectly formed and the *row* is in a state that
 * cannot be honoured, which is #42's distinction, and answering it 400 would tell a caller their
 * click was malformed when what they found is a column a previous door stored junk into.
 */
export function listRefreshAsk(rowIsDynamic: boolean, filterProblem: string | null): ListRefreshAsk {
  if (!rowIsDynamic) {
    return {
      ok: false,
      http: 400,
      error: "this list is not dynamic — its `isDynamic` is false, so it has no filter to re-run and its members are what an operator put in it",
    };
  }
  if (filterProblem !== null) {
    return { ok: false, http: 409, error: `this list's filter cannot be re-run as written: ${filterProblem}` };
  }
  return { ok: true, http: 200, error: null };
}
