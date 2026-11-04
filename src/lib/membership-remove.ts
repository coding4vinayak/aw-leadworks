/**
 * The arithmetic a membership *removal* owes its caller. `?action=refresh` on the same handler
 * already reports `removed: plan.remove.length` and `csv-import.ts` counts the rows the index
 * settled "so the report always adds up"; the branch next to both was the one that answered a
 * verdict without its numbers.
 *
 * Measured on a live instance (aw-leadworks at `ff38306`, built in a fresh worktree, booted on
 * :3443 over this session's own database `leadworks_r78`, private Redis 6426, keys read from
 * `0600` files and printed nowhere; presses in `/tmp/opencode/r78_press_base.log`). One static
 * list holding `ld_r78_1`, `ld_r78_2`, `ld_r78_3`, the same request path and the same key:
 *
 *   POST /api/lead-lists/{full}?action=remove-leads {"leadIds":["ld_r78_1"]}
 *     200 / 11 {"ok":true}   — and `ld_r78_1` came off the list
 *   POST … {"leadIds":["ld_r78_4"]}            (in the workspace, not on the list)
 *     200 / 11 {"ok":true}   — and nothing came off
 *   POST … {"leadIds":["ld_r78_1","ld_r78_4"]} (one held, one not)
 *     200 / 11 {"ok":true}   — and exactly `ld_r78_1` came off
 *   POST … {"leadIds":["ld_r78_1","ld_r78_2","ld_r78_3"]}
 *     200 / 11 {"ok":true}   — and the list was left empty
 *   POST … {"leadIds":["ld_nope_r78"]}         (no such lead)   200 / 11, nothing came off
 *   POST … {"leadIds":["ld_r78_b1"]}           (another tenant's lead)  200 / 11, nothing came off
 *
 * Six outcomes, one byte-identical reply. A caller who mistypes an id, retries a removal that
 * already happened, or removes a crowd half of which was never on the list cannot tell any of
 * them apart from the full removal — and the removal is the one write where a retry is normal,
 * because "already off" *is* success.
 *
 * The no-op stays a 200 and is not turned into a 4xx: the caller's goal (these leads are not on
 * this list) is true either way, and that refusal would invent a failure for a request that
 * succeeded. What changes is only that the answer says which way it went. `deleteMany` already
 * returns the rows it matched, and Postgres settles it in the statement, so `removed` is the
 * count the database reported and `absent = requested - removed` is arithmetic on it — the same
 * shape `csv-import.ts` and the refresh branch use.
 *
 * `requested` is the crowd as this app reads a caller's list: `asStrings` trims, refuses a
 * non-string entry and de-duplicates, so a lead named twice is asked for once, and
 * `removed + absent` is always `requested`.
 */
export interface MembershipRemoval {
  ok: true;
  /** The distinct ids the caller asked to take off. */
  requested: number;
  /** The rows the database actually deleted. */
  removed: number;
  /** The ids that were not on the list, which is why the answer is not a refusal. */
  absent: number;
}

export function membershipRemoval(requested: number, removed: number): MembershipRemoval {
  return { ok: true, requested, removed, absent: requested - removed };
}
