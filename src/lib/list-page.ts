/**
 * The membership page `GET /api/lead-lists/{id}` answers with, and what it says about the rest.
 *
 * The list's own detail door reads `include: { members: { include: { lead: true }, take: 100 } }`
 * — no `orderBy`, no `skip`, and no answer about what it left out. Measured on the running app
 * before this file existed, on a list this session re-ran its filter over (the crowd was 150 leads
 * written through `POST /api/leads`, and the refresh door is the one #44 made mean something):
 *
 * ```
 *   POST /api/lead-lists/{id}?action=refresh  -> {"matched":150,"added":150,"members":150}
 *   GET  /api/lead-lists/{id}                 -> 200, `members` holds 100 rows, 163,031 bytes
 *                                                every key in the body: id, workspaceId, name,
 *                                                description, isDynamic, filterJson, createdAt,
 *                                                updatedAt, members — nothing that says 150
 *   GET  the same list again                  -> the same 100 rows, in the same order
 *   GET  ?limit=5 / ?page=2&limit=5 / ?memberOffset=100 -> 100 rows each time, all ignored
 *   GET  /api/lead-lists                      -> {_count:{members:150}} for this very list
 * ```
 *
 * Three facts sit in those lines. The refresh door said 150 and the read door handed back 100 of
 * them with **nothing in the body telling a caller the crowd is larger than the answer** — while
 * the collection door, one request earlier, counts the same 150 and does say so. The 50 leads past
 * the window are unreachable: no query string changes what `take` the route passes. And `take: 100`
 * with no `orderBy` is not "the first 100"; it is whichever 100 the database happened to choose,
 * which agreed twice under measurement and is promised never.
 *
 * `lib/job-report.ts` already solved this shape for `GET /api/jobs/{id}`: `results` is `take: 50`
 * of the records and the door returns `results: { recorded, returned, truncated }` beside them,
 * "because 50-of-50 is not 50-of-4,000". This is the same sentence about a members array, and the
 * count comes from the database for the same reason it does there.
 */
export interface MemberPage {
  /** Rows in `LeadListMember` for this list — counted, not inferred from what was returned. */
  recorded: number;
  /** Rows this answer carries. */
  returned: number;
  page: number;
  limit: number;
  totalPages: number;
  truncated: boolean;
}

/**
 * What the `members` array in this answer is, against the whole membership.
 *
 * `truncated` is "**rows exist this page does not carry**" — `page * limit < recorded` — not
 * `recorded > returned`: a page beyond the last returns nothing and is not truncated, and a page
 * that came back short is the last page by construction. `totalPages` is the ceiling of the same
 * division, so `0` is a list with no members, and a caller asking for page 7 of 2 gets an honest
 * `[]` beside a `false` and a `recorded` that says how many there are.
 */
export function memberPage(recorded: number, returned: number, page: number, limit: number): MemberPage {
  return {
    recorded,
    returned,
    page,
    limit,
    totalPages: Math.ceil(recorded / limit),
    truncated: page * limit < recorded,
  };
}
