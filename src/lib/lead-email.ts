import { NextResponse } from "next/server";

/**
 * The address one row of `Lead` means, judged the way the rest of the product judges it.
 *
 * `@@unique([workspaceId, email])` compares bytes, so a workspace that holds `john@x.com`
 * accepts `JOHN@X.COM` as a second row and `John@X.com` as a third. Everything else in the
 * app already decided those are one person:
 *
 * - `src/lib/csv-import.ts` looks for the address with `mode: "insensitive"` before it inserts,
 *   and stores the address lower-cased, so the file door reports `duplicatesExisting: 1` for a
 *   row the one-lead door would have created;
 * - `src/lib/dedupe.ts:216` calls the two rows duplicates by definition
 *   (`a.email.toLowerCase() === b.email.toLowerCase()`), and `runDedupeJob` then spends a merge
 *   folding away what the door just accepted (measured on the base build: a DEDUPE job over three
 *   spellings of one address reported `found=2 resolved=2` and left one row);
 * - `src/app/auth-actions.ts` lower-cases the address before it looks for an account.
 *
 * The two doors that take an address from a caller — `POST /api/leads` and
 * `PATCH /api/leads/{id}` — asked the index nothing about case, so they were the only places a
 * person could be written twice.
 *
 * What is refused here is the *second row*, not the spelling: nothing rewrites the bytes of a row
 * that already exists, and a brand-new address is stored exactly as it was sent. A collision with
 * the same bytes is left to the index, because that refusal already exists, is a 409, and this
 * file has nothing to add to it.
 */

/** A row that holds an address. */
export interface EmailHolder {
  id: string;
  email: string;
}

/**
 * The holder of `asked` that is not the same string, or `null` when there is none.
 *
 * `holders` is the result of a `mode: "insensitive"` lookup scoped to the caller's workspace, so
 * it can hold the very row a `PATCH` is editing — that door leaves it out of the lookup, because
 * a row is allowed to keep its own address in any case, or every edit that resends the email
 * field would be refused by itself.
 *
 * A byte-identical row among the holders makes this stand down and return `null`. The unique
 * index answers that request — as a 409, without this file's help — and a caller who sent the
 * exact bytes a row already holds is not asking "is this the same person", so the sentence here
 * would only get in the way of the one the database already gives.
 *
 * Of the spellings that do collide, the first in `holders` is named, so both doors ask the
 * database for `orderBy: { createdAt: "asc" }`: without it, a workspace holding three spellings
 * of one address would name whichever row Postgres happened to return first, and two identical
 * presses would get two different refusals.
 */
export function emailCaseHolder(asked: string, holders: { id: string; email: string | null }[]): EmailHolder | null {
  const others = holders.filter((row): row is EmailHolder => typeof row.email === "string");
  if (others.some((row) => row.email === asked)) return null;
  const folded = asked.toLowerCase();
  return others.find((row) => row.email.toLowerCase() === folded) ?? null;
}

/**
 * The refusal: a 409, like the index's own, naming the column, the row it collided with and both
 * spellings. The id is the point — a caller who gets a plain "already exists" for an address it
 * just sent has no way to find the row it meant, and the row it meant is what it has to edit,
 * merge or dedupe instead.
 */
export function emailCaseConflict(holder: EmailHolder, asked: string): NextResponse {
  return NextResponse.json(
    {
      error:
        `A Lead with this email already exists in this workspace as ${holder.id}: ` +
        `${JSON.stringify(asked)} is ${JSON.stringify(holder.email)} with the case changed.`,
      conflict: {
        fields: ["email"],
        existingId: holder.id,
        existingEmail: holder.email,
        askedEmail: asked,
      },
    },
    { status: 409 },
  );
}
