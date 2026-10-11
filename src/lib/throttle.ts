import { headers } from "next/headers";
import { prisma } from "@/lib/db";

/**
 * Limits on the two forms that have no session behind them.
 *
 * Before this, a wrong password cost about 100ms of scrypt and nothing else, so
 * guessing was unbounded and the same endpoint would happily burn CPU for anyone
 * who asked. Two problems, one mechanism: the counter is read *before* anything
 * is hashed, so a spent address is answered in about a millisecond and the
 * expensive path stops being reachable at all.
 *
 * Buckets are keyed by client address and never by the email that was typed. A
 * per-account limit is a denial-of-service gift: fail against someone's address a
 * few hundred times and you have locked them out of their own workspace.
 */

/** The window an address gets its budget over. */
const WINDOW_MS = 15 * 60 * 1000;
/** How long a spent budget stays spent. */
const LOCK_MS = 15 * 60 * 1000;

/**
 * Ten guesses per address per fifteen minutes. Passwords here are at least eight
 * characters, so this cannot find one, and it is more than a forgetful person on
 * a shared office connection will ever spend.
 */
export const MAX_SIGNIN_FAILURES = 10;

/**
 * Five workspaces per address per window, and tallied on *success* rather than on
 * failure: typing an email that already exists is a legitimate thing to do, and
 * counting it would punish the next person behind the same NAT exit. Only account
 * farming reaches this ceiling.
 */
export const MAX_SIGNUPS = 5;

export type Gate = { allowed: true } | { allowed: false; retryAfterMinutes: number };

/**
 * The address that asked.
 *
 * `cf-connecting-ip` first, because Cloudflare rewrites it and a caller cannot
 * choose it. On a deploy without Cloudflare in front there is nothing better than
 * `x-forwarded-for`, whose leftmost entry *is* caller-chosen — so the limit there
 * is a speed bump, not a wall. The fix for that is keeping the origin unreachable
 * except through the proxy, not parsing the header harder.
 */
export async function clientAddress(): Promise<string> {
  const h = await headers();
  const direct = h.get("cf-connecting-ip")?.trim();
  if (direct) return direct.slice(0, 45);
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 45);
  return (h.get("x-real-ip")?.trim() || "unknown").slice(0, 45);
}

/** Whether an address may try again, and how long to wait if it may not. */
export async function gate(key: string): Promise<Gate> {
  const row = await prisma.authThrottle.findUnique({ where: { key } });
  if (!row) return { allowed: true };
  const locked = row.lockedUntil ? row.lockedUntil.getTime() : 0;
  const now = Date.now();
  if (locked > now) {
    return {
      allowed: false,
      retryAfterMinutes: Math.max(1, Math.ceil((locked - now) / 60_000)),
    };
  }
  return { allowed: true };
}

/**
 * Count one event against an address, and lock it once the budget is spent.
 *
 * The window only restarts when the old one has run out; resetting it on every
 * event would let an attacker pace one guess per window forever. Rows that
 * expired a while ago are dropped when a lock is taken, which is the one moment
 * an address has proved it is worth pruning for, and keeps a spray of invented
 * addresses from growing the table without bound.
 */
export async function tally(key: string, limit: number): Promise<number> {
  const now = Date.now();
  const row = await prisma.authThrottle.findUnique({ where: { key } });
  const expired = !row || now - row.windowStart.getTime() > WINDOW_MS;
  const count = expired ? 1 : (row?.count ?? 0) + 1;
  const lockedUntil = count >= limit ? new Date(now + LOCK_MS) : null;

  await prisma.authThrottle.upsert({
    where: { key },
    create: { key, count, windowStart: new Date(now), lockedUntil },
    update: { count, windowStart: expired ? new Date(now) : (row?.windowStart ?? new Date(now)), lockedUntil },
  });

  if (lockedUntil) {
    await prisma.authThrottle.deleteMany({
      where: { lockedUntil: null, windowStart: { lt: new Date(now - 2 * WINDOW_MS) } },
    });
  }
  return count;
}

/**
 * Wipe an address's failed guesses after it signs in successfully.
 *
 * Without this the budget never comes back early, so the person who finally
 * remembers their password is punished for the ones who did not.
 */
export async function clearTally(key: string): Promise<void> {
  await prisma.authThrottle.deleteMany({ where: { key } });
}

/** The sign-in bucket for an address. */
export function signInKey(address: string): string {
  return `signin:${address}`;
}

/** The sign-up bucket for an address. */
export function signUpKey(address: string): string {
  return `signup:${address}`;
}

/**
 * Form submissions posted with a publishable key, per address.
 *
 * A publishable key is by definition printed in someone's website bundle, so the
 * only thing standing between it and an open write endpoint is this budget. Thirty
 * enquiries from one address in a window is generous for the person who hits submit
 * twice and useless for anyone trying to fill a workspace; secret keys are not
 * capped, because a bulk backfill is a legitimate thing to do with one.
 */
export const MAX_PUBLISHABLE_INGESTS = 30;

/**
 * The budget window in seconds, exported so a 429 can quote its own quota in
 * the standard RateLimit headers rather than hard-coding a second copy of it.
 */
export const PUBLISHABLE_WINDOW_SECS = WINDOW_MS / 1000;
/** The ingest bucket for an address. */
export function publishableIngestKey(address: string): string {
  return `pubingest:${address}`;
}
