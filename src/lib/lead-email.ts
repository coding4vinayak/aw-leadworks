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
 * The address with `ILIKE`'s metacharacters escaped to themselves.
 *
 * `mode: "insensitive"` is Prisma's spelling of `ILIKE` on Postgres, and `%` and `_` are that
 * operator's wildcards rather than characters of the address. Measured on the fix build before this
 * function existed, over the seeded rows: `?email=%@x.com` answered `total=9` — every `@x.com` row —
 * `?email=a_c@x.com` answered `total=1`, naming `abc@x.com`, and `?email=50%@x.com` answered two
 * rows, the stored `50%@x.com` beside its neighbour `50Z@x.com`. A door that answers a pattern is a
 * second door: it returns addresses the caller did not name. Backslash is escaped too, because it is
 * `LIKE`'s own escape character (the default, so `\%` is a literal percent without an `ESCAPE`
 * clause); escaping it first is what keeps a caller-supplied `\` from escaping the `%` after it.
 */
function likeValue(asked: string): string {
  return asked.replace(/[\\%_]/g, (pattern) => `\\${pattern}`);
}

/**
 * How one caller-named address is compared to the ones the workspace holds — written once, because
 * four doors ask the same question and a fifth would ask it differently.
 *
 * `Lead.email` is `@unique` with `workspaceId` on **bytes**, while the product's answer to "is this
 * the same person" has always been case-folded: `csv-import.ts` looks up with `mode: "insensitive"`
 * before it inserts, `dedupe.ts` calls two spellings duplicates by definition, and the two write
 * doors refuse a case-changed collision with a 409 naming the row (`emailCaseConflict` below). A
 * read door that compared bytes instead answered `200 total=0` for exactly those bytes — measured on
 * `ff38306`, `GET /api/leads?email=john@x.com` found nobody while `POST /api/leads
 * {email:"john@x.com"}` said `already exists in this workspace … with the case changed`.
 *
 * The value stays the caller's own address; nothing here lower-cases it. What does change is the
 * pattern's own syntax: `%`, `_` and `\` are escaped by `likeValue` so the insensitive comparison
 * matches the address's characters and nothing wider. Without that step the fold is a wildcard
 * filter — measured, quoted above `likeValue` — and `?email=%` would be "every address".
 *
 * What it costs is the composite index, and the `workspaceId` prefix with it. Measured on a
 * 30,000-row scratch table carrying the same `@@unique([workspaceId, email])`: the byte-exact
 * predicate is an `Index Only Scan`, and the folded one is a `Seq Scan` filtered on both columns —
 * `ILIKE` cannot use the btree at all. That is the cost `csv-import.ts` has paid since it folded,
 * and the two write doors pay it per address they take; the door this round fixed pays it per page
 * requested.
 */
export function emailFold(asked: string): { equals: string; mode: "insensitive" } {
  return { equals: likeValue(asked), mode: "insensitive" };
}

/** The same comparison for a page of addresses, as one file's worth of them arrives at a time. */
export function emailFoldIn(asked: string[]): { in: string[]; mode: "insensitive" } {
  return { in: asked.map(likeValue), mode: "insensitive" };
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
