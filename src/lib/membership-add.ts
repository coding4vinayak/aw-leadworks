/**
 * The arithmetic a membership write owes its caller, in one place, because two
 * doors write the same pair and were answering it differently from each other
 * and from themselves.
 *
 * Measured on a live instance (aw-leadworks at `ff38306`, built in a fresh
 * worktree, booted on :3439 over this session's own database `leadworks_r76`,
 * private Redis 6422, keys read from `0600` files and printed nowhere; presses
 * in `/tmp/opencode/r76_press_ab.log` and `/tmp/opencode/r76_press_extra.log`).
 * The crowd `ld_r76_1`, already a member of `lst_r76_partial`, and `ld_r76_2`,
 * not on it:
 *
 *   POST /api/lead-lists/{partial}?action=add-leads {"leadIds":["ld_r76_1"]}
 *     409 {"error":"A LeadListMember with this listId + leadId already exists
 *          in this workspace.","conflict":{"fields":["listId","leadId"]}}
 *   POST … {"leadIds":["ld_r76_1","ld_r76_2"]}
 *     409, same body — and `ld_r76_2` was not added (read back: the list still
 *     held only `ld_r76_1`)
 *   POST /api/leads/{ld_r76_1}?action=add-to-list {"listId":"…partial"}
 *     409, same body
 *
 * — while the door two lines below the first one, asked to remove a lead that
 * was not on the list, answered `200 {"ok":true}`, and `POST /api/leads` folds a
 * repeated `listIds` entry with `skipDuplicates` rather than letting the index
 * refuse it. So the same truth about a pair — already true, nothing left to do —
 * was a no-op at one door, a folded duplicate at another and a refusal that
 * discarded the rest of the crowd at these two.
 *
 * A refusal here also costs the caller their work, not just their status code:
 * `createMany` is one statement, so the pair that was already present rolled the
 * pair that was not back out. Postgres settles which rows landed, and the insert
 * count is what makes the report add up — the rule `csv-import.ts` states as
 * "count those in the same duplicate bucket so the report always adds up".
 *
 * `requested` is the crowd as this app reads a caller's list: `asStrings` trims,
 * refuses a non-string entry and de-duplicates, so a lead named twice is asked
 * for once, and `added + already` is always `requested`.
 */
export interface MembershipReport {
  ok: true;
  /** The distinct pairs the caller asked for. */
  requested: number;
  /** The pairs the database actually wrote. */
  added: number;
  /** The pairs that were already true, which is why the answer is not a refusal. */
  already: number;
}

export function membershipReport(requested: number, added: number): MembershipReport {
  return { ok: true, requested, added, already: requested - added };
}
