// Query-string numbers for the read routes, clamped before they reach Prisma.
//
// Three shapes go wrong without a clamp. `limit=999999999` is the full-table
// read that pagination exists to prevent. `page=0` arrives as a negative
// `skip` and `page=abc` as NaN, both of which throw — so a mistyped query
// string is a 500 instead of a list. And `Math.min(parseInt(raw), cap)` still
// passes NaN through to `take`, because Math.min of NaN is NaN.
//
// Rule used here: an unparseable value, or one below the legal minimum, falls
// back to the default; anything above the maximum is clamped to it. A default
// is a known-good number, so the route can never see NaN.
export function intParam(
  searchParams: URLSearchParams,
  name: string,
  dflt: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(searchParams.get(name) ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < min) return dflt;
  return Math.min(parsed, max);
}

export function pageParams(
  searchParams: URLSearchParams,
  defaultLimit: number,
  maxLimit = 100,
): { page: number; limit: number } {
  return {
    page: intParam(searchParams, "page", 1, 1, Number.MAX_SAFE_INTEGER),
    limit: intParam(searchParams, "limit", defaultLimit, 1, maxLimit),
  };
}

/**
 * The second key every paged list sorts on, so that its order is total.
 *
 * A page is a slice — `skip: (page - 1) * limit, take: limit` — and a slice is only
 * reproducible if the order it cuts is total. `#48` recorded this as a limit it would not
 * pretend away ("The order has no tiebreaker"), and `#45` had already fixed it at one door by
 * ordering members on `leadId`, which is unique within a list. This is that rule, taken to the
 * five doors that page over a column many rows share.
 *
 * Measured on the running app before this was written (`ff38306`, `:3435` over this session's
 * own `leadworks_r74`, `/tmp/opencode/r74_press_ab.log`) over crowds an importer would have
 * written in one transaction — 13 leads all at `score=50`, nine sources, jobs, exports and lists
 * all sharing one `createdAt`, because `now()` is the transaction timestamp:
 *
 * ```
 *   GET /api/leads?limit=3  walked over 5 pages -> 13 rows, 12 distinct:
 *        p1 ld_r74_06,09,00 | p2 ld_r74_03,08,00 | ...  `ld_r74_00` twice, `ld_r74_02` never
 *   GET /api/leads?limit=2                        -> 11 distinct of 13
 *   the same walk at limit=4, 5, 7                -> all 13, so the page size decides it
 *   GET /api/{sources,jobs,exports,lead-lists}?limit=2 -> 8 distinct of 9, one row repeated
 *   GET /api/leads?limit=3&page=1&fields=email,score -> tied12,11,10 where the same URL without
 *        `fields` answered tied06,09,00: one door, one page, two answers, on all five pages
 * ```
 *
 * Which of the tied rows lands on a page is the sort's accident, so a caller walking pages to
 * export a crowd gets some rows twice and others not at all — the failure is silent because
 * `total` and `totalPages` stay correct. `id` breaks the tie because every table here has one
 * and it is unique by construction, which makes the order total and the walk reproducible.
 * Ascending, the way both precedents are: `RULE_PRIORITY_ORDER` ends `{ id: "asc" }` and `#45` put
 * `leadId asc` on the membership window, so every tie in this app resolves upward on a unique key.
 */
export const PAGED_TIEBREAK = { id: "asc" } as const;
