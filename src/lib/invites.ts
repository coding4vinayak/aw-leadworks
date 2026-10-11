import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";
import { isInvitableRole, type InvitableRole } from "./roles";
import { getEmailSender, renderInviteEmail } from "./email";

/**
 * Invitations: the mechanics of a single-use link.
 *
 * Who may hand out which role lives in `roles.ts`, next to the rule the API key
 * guard reads. This module sits in lib rather than in the server action so the
 * parts that carry weight — is the link still live, can it be redeemed twice,
 * does it name the right person — are ordinary functions a script can drive
 * against a real database. `src/app/members/actions.ts` is then only session
 * resolution, form parsing and messaging.
 */

/** A week: long enough to be accepted from an email, short enough that an
 *  abandoned link stops being a door left standing open. */
export const INVITE_TTL_DAYS = 7;

/** The same shape the signup form accepts, so an address that can register is an
 *  address that can be invited, and no other. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function normaliseInviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  // 254 is the longest address a mail system will accept. Storing anything
  // longer means the invite can never be matched against a real account.
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function inviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export type InviteOutcome =
  | { ok: true; token: string; email: string; role: InvitableRole; expiresAt: Date; rotated: boolean }
  | { ok: false; error: string };

/**
 * Issue an invitation and return the one-time link.
 *
 * Re-inviting an address that already has a live invite **rotates** it: a new
 * token replaces the stored hash, so the earlier link stops working and exactly
 * one is live. That is the only option that respects the hashing rule — a link
 * cannot be shown again on request, because what is stored is a digest of
 * something the database no longer contains. Rotating also means the person who
 * double-clicked "Invite" gets one working link rather than two to keep straight,
 * and the copy they pasted into chat first becomes worthless on purpose.
 */
export async function createInvite(input: {
  workspaceId: string;
  email: string;
  role: string;
  createdById: string;
  now?: Date;
}): Promise<InviteOutcome> {
  const email = normaliseInviteEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  if (!isInvitableRole(input.role)) {
    return { ok: false, error: "Invitations can grant admin or member access." };
  }

  const now = input.now ?? new Date();

  const alreadyMember = await prisma.membership.findFirst({
    where: { workspaceId: input.workspaceId, user: { email } },
    select: { id: true },
  });
  if (alreadyMember) {
    return { ok: false, error: "That person is already a member of this workspace." };
  }

  const { token, tokenHash } = generateInviteToken();
  const expiresAt = inviteExpiry(now);

  const pending = await prisma.invite.findFirst({
    where: { workspaceId: input.workspaceId, email, acceptedAt: null, expiresAt: { gt: now } },
    select: { id: true },
  });

  if (pending) {
    await prisma.invite.update({
      where: { id: pending.id },
      data: { tokenHash, role: input.role, expiresAt, createdAt: now },
    });
    return { ok: true, token, email, role: input.role, expiresAt, rotated: true };
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { name: true },
  });
  const inviter = await prisma.user.findUnique({
    where: { id: input.createdById },
    select: { name: true, email: true },
  });

  const product = process.env.PRODUCT_NAME ?? "Abetworks";
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/invite/${token}`;

  await prisma.invite.create({
    data: {
      workspaceId: input.workspaceId,
      email,
      role: input.role,
      tokenHash,
      createdById: input.createdById,
      expiresAt,
    },
  });

  const { subject, html, text } = renderInviteEmail({
    product,
    inviterName: inviter?.name ?? null,
    workspaceName: workspace?.name ?? "the workspace",
    role: input.role,
    inviteUrl,
    expiresDays: INVITE_TTL_DAYS,
  });
  // Fire-and-forget: the invite row is already committed and the caller is shown
  // the link, so a provider outage delays the invite rather than losing it.
  void getEmailSender()
    .send(email, subject, html, text)
    .catch((err) => console.error("[invite] Failed to send email:", err));

  return { ok: true, token, email, role: input.role, expiresAt, rotated: false };
}

export type AcceptOutcome =
  | { ok: true; workspaceId: string; role: InvitableRole }
  | { ok: false; error: string };

/** One copy of the message for a token that matches nothing, so the page and the
 *  redemption cannot drift into explaining the same failure differently. */
const INVITE_UNKNOWN = "That invitation does not exist.";

/** Why a stored invitation is not currently a way in, or null if it is. */
export function inviteProblem(
  invite: { acceptedAt: Date | null; expiresAt: Date } | null,
  now: Date = new Date(),
): string | null {
  if (!invite) return INVITE_UNKNOWN;
  if (invite.acceptedAt) return "That invitation has already been used.";
  if (invite.expiresAt.getTime() <= now.getTime()) {
    return "That invitation has expired. Ask to be sent a new one.";
  }
  return null;
}

/**
 * Redeem a token on behalf of the signed-in account.
 *
 * Four refusals, each for a different reason:
 *
 *   - expired or already used: that string is not a credential any more.
 *   - the account is not the address on the invite. Without this check a link
 *     pasted into a group chat is an open door for whoever reads it, so the
 *     invite names a person, not just a workspace.
 *   - the account is already a member: its existing role is left alone rather
 *     than upgraded, so rediscovering an old ADMIN link cannot lift a MEMBER.
 *     Changing someone's role needs an explicit action by an owner.
 *   - nothing matches the token at all, which is also the answer to a token from
 *     a different deployment sharing this database.
 *
 * `acceptedAt` is claimed with a conditional update instead of read-then-write,
 * so two people arriving on the same link at the same instant cannot both be
 * let in: exactly one of the updates changes a row, and the loser sees "already
 * been used".
 */
export async function acceptInvite(input: {
  token: string;
  userId: string;
  now?: Date;
}): Promise<AcceptOutcome> {
  const now = input.now ?? new Date();
  if (!input.token) return { ok: false, error: INVITE_UNKNOWN };

  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(input.token) },
  });
  // The null case is split out of inviteProblem and checked here as well: the
  // shared function keeps the wording identical to the page that shows the link
  // before it is redeemed, and this copy is what tells the type checker the row
  // below has an id.
  if (!invite) return { ok: false, error: INVITE_UNKNOWN };
  const problem = inviteProblem(invite, now);
  if (problem) return { ok: false, error: problem };

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true },
  });
  if (!user) return { ok: false, error: "Your session has expired. Sign in again." };
  if (user.email !== invite.email) {
    return {
      ok: false,
      error: `This invitation was sent to ${invite.email}, and you are signed in as ${user.email}.`,
    };
  }
  if (!isInvitableRole(invite.role)) {
    return { ok: false, error: "That invitation grants a role this product cannot issue." };
  }

  const existing = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId } },
  });
  if (existing) {
    return {
      ok: false,
      error: "You already have access to this workspace, so nothing has changed.",
    };
  }

  const claimed = await prisma.invite.updateMany({
    where: { id: invite.id, acceptedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now },
  });
  if (claimed.count !== 1) {
    return { ok: false, error: "That invitation has already been used." };
  }

  await prisma.membership.create({
    data: { userId: user.id, workspaceId: invite.workspaceId, role: invite.role },
  });

  return { ok: true, workspaceId: invite.workspaceId, role: invite.role };
}

/** Outstanding invitations for a workspace, newest first. */
export async function listPendingInvites(workspaceId: string, now: Date = new Date()) {
  return prisma.invite.findMany({
    where: { workspaceId, acceptedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
}

/**
 * Withdraw an invitation.
 *
 * The workspace id is part of the delete, not a check afterwards: a caller that
 * guesses another tenant's invite id gets "no longer pending" rather than a
 * deletion, because there is no version of this function that should be able to
 * reach across a tenant boundary.
 */
export async function revokeInvite(input: {
  workspaceId: string;
  inviteId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const removed = await prisma.invite.deleteMany({
    where: { id: input.inviteId, workspaceId: input.workspaceId, acceptedAt: null },
  });
  if (removed.count !== 1) return { ok: false, error: "That invitation is no longer pending." };
  return { ok: true };
}
