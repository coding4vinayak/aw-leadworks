import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { prisma } from "./db";

/**
 * Browser sessions.
 *
 * Three decisions worth stating, because they are the ones that are expensive
 * to change later:
 *
 * 1. The session token is stored **hashed**. The cookie holds a random 32-byte
 *    token; the database holds only its sha256. If the database is ever dumped,
 *    the attacker gets unusable hashes rather than a set of working logins.
 *    This mirrors how API keys are already handled in each app's `apikeys.ts`,
 *    so there is one rule in the codebase instead of two.
 * 2. The workspace lives **on the session**, not only on the user. The session
 *    records which workspace is currently open, so moving between teams is a
 *    column change on this row rather than a second parallel login. Teams
 *    arrived as a migration, not a redesign, because of this.
 * 3. The seat is re-checked on every resolution. A session whose membership was
 *    revoked is destroyed on sight, because every query downstream filters on
 *    session.workspaceId and would otherwise keep serving a departed teammate
 *    the team they were just removed from.
 */

const COOKIE_NAME = process.env.SESSION_COOKIE ?? "abetworks_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days.

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, workspaceId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS);

  await prisma.session.create({
    data: { userId, workspaceId, tokenHash: hashSessionToken(token), expiresAt },
  });

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, // Unreadable from JavaScript, so an XSS bug cannot steal it.
    sameSite: "lax", // Still sent on the top-level redirect back from an email link.
    secure: process.env.NODE_ENV === "production", // Plain HTTP is only for localhost.
    path: "/",
    expires: expiresAt,
  });
}

export interface ActiveSession {
  userId: string;
  email: string;
  name: string | null;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  /** The seat's role in the open workspace: OWNER | ADMIN | MEMBER. */
  role: string;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  }
  jar.delete(COOKIE_NAME);
}

/** Destroy every session a user holds. Used when a seat is removed or a password is reset. */
export async function destroyUserSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * Resolve the session for the current request.
 *
 * Wrapped in React's `cache` so the dashboard, the header and any server action
 * in the same render share one lookup instead of re-querying per component.
 */
export const getSession = cache(async (): Promise<ActiveSession | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  // Deliberately not `include: { user: true, workspace: true }`. Both relations
  // are required, so Prisma throws "Field user is required to return data" if
  // the row is gone — a 500 on a stale cookie, before any code here can check.
  // (Foreign keys cascade this in a correct database, but SQLite deployments
  // with foreign keys off, or a hand-restored backup, can still reach it.)
  // Loading them separately turns "impossible" into "signed out".
  const record = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
  });
  if (!record) return null;

  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: record.userId } }),
    prisma.workspace.findUnique({ where: { id: record.workspaceId } }),
  ]);
  // A cookie that cannot name a person, or a workspace, is not a session. Both
  // are signed out and the row dropped rather than left to fail again.
  if (!user || !workspace) {
    await prisma.session.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    // Expired sessions are deleted on sight, so the table does not accumulate
    // rows that can never authenticate anything.
    await prisma.session.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  // A session whose seat was taken away is over. This is the check that makes
  // membership revocation real: without it, removing someone would leave their
  // cookie working until it expired.
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    select: { role: true },
  });
  if (!membership) {
    await prisma.session.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    role: membership.role,
  };
});

/**
 * The session, or a redirect to the login screen.
 *
 * Every page that reads a customer's data goes through this, which is what
 * makes the app multi-tenant: there is no code path left that reads "the first
 * workspace in the table".
 */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Move the current session into another workspace the same person belongs to.
 *
 * A column change on this row, not a second login: the credential is the same,
 * only the open workspace changes. Refused — back to the dashboard, not to an
 * error page — when the target is not one of theirs, because a URL that moves
 * anyone into any team is the alternative.
 */
export async function openWorkspace(workspaceId: string): Promise<void> {
  const session = await getSession();
  if (!session) redirect("/login");
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: session.userId, workspaceId } },
    select: { id: true },
  });
  if (!membership) redirect("/dashboard");

  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: hashSessionToken(token) },
      data: { workspaceId },
    });
  }
  redirect("/dashboard");
}
