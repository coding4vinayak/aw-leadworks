import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./db";

/**
 * Single-use tokens for email verification and password reset.
 *
 * Both are stored **hashed**, exactly like session tokens and API keys: the
 * plaintext exists only in the email we send, so a database dump yields no
 * redeemable links. One rule for every secret in this codebase.
 *
 * Both are single-use — redeemed, they are deleted in the same transaction that
 * applies the change, so a link clicked twice cannot be replayed.
 */

export const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;
export const PASSWORD_RESET_TOKEN_EXPIRY_HOURS = 1;

/** Reset requests are limited per address, not per IP: the target is the victim. */
export const PASSWORD_RESET_RATE_LIMIT = 3;
export const PASSWORD_RESET_WINDOW_HOURS = 1;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function expiryIn(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * Issue a verification token, replacing any previous one.
 *
 * Reissuing deletes the old token rather than adding a second: two live
 * verification links means the older one still works after someone asked for a
 * fresh email, which is how a link forwarded years ago stays useful.
 */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = newToken();
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.create({
      data: { userId, tokenHash: hashToken(token), expiresAt: expiryIn(VERIFICATION_TOKEN_EXPIRY_HOURS) },
    }),
  ]);
  return token;
}

/**
 * Redeem a verification token. Returns true only if it matched a live record,
 * and deletes it either way so a wrong guess burns nothing but a correct token
 * is spent exactly once.
 */
export async function consumeEmailVerificationToken(userId: string, token: string): Promise<boolean> {
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.userId !== userId || record.expiresAt < new Date()) return false;
  await prisma.emailVerificationToken.delete({ where: { id: record.id } });
  return true;
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = newToken();
  await prisma.passwordResetToken.deleteMany({ where: { userId } });
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: expiryIn(PASSWORD_RESET_TOKEN_EXPIRY_HOURS) },
  });
  return token;
}

export async function consumePasswordResetToken(userId: string, token: string): Promise<boolean> {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.userId !== userId || record.expiresAt < new Date()) return false;
  await prisma.passwordResetToken.delete({ where: { id: record.id } });
  return true;
}

/** Fetch the user a reset token belongs to, without consuming it. */
export async function findPasswordResetTokenUser(token: string): Promise<{ userId: string } | null> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { userId: true, expiresAt: true },
  });
  if (!record || record.expiresAt < new Date()) return null;
  return { userId: record.userId };
}

export async function checkPasswordResetRateLimit(email: string): Promise<{ allowed: boolean; retryAfterMinutes?: number }> {
  const key = `pwreset:${email}`;
  const row = await prisma.authThrottle.findUnique({ where: { key } });
  if (!row) return { allowed: true };

  const lockedUntil = row.lockedUntil?.getTime() ?? 0;
  if (lockedUntil > Date.now()) {
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000)) };
  }
  const windowStart = row.windowStart.getTime();
  if (Date.now() - windowStart < PASSWORD_RESET_WINDOW_HOURS * 60 * 60 * 1000 && row.count >= PASSWORD_RESET_RATE_LIMIT) {
    const resetIn = PASSWORD_RESET_WINDOW_HOURS * 60 * 60 * 1000 - (Date.now() - windowStart);
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(resetIn / 60000)) };
  }
  return { allowed: true };
}

export async function recordPasswordResetAttempt(email: string): Promise<void> {
  const key = `pwreset:${email}`;
  const row = await prisma.authThrottle.findUnique({ where: { key } });
  const now = Date.now();

  if (!row || now - row.windowStart.getTime() >= PASSWORD_RESET_WINDOW_HOURS * 60 * 60 * 1000) {
    await prisma.authThrottle.upsert({
      where: { key },
      create: { key, count: 1, windowStart: new Date(now) },
      update: { count: 1, windowStart: new Date(now), lockedUntil: null },
    });
    return;
  }

  const count = row.count + 1;
  await prisma.authThrottle.upsert({
    where: { key },
    create: { key, count, windowStart: new Date(now) },
    update: {
      count,
      // Past the limit the bucket locks outright, so a third request cannot
      // reset the window by waiting for it to roll.
      ...(count > PASSWORD_RESET_RATE_LIMIT ? { lockedUntil: new Date(now + PASSWORD_RESET_WINDOW_HOURS * 60 * 60 * 1000) } : {}),
    },
  });
}

/**
 * The public base URL used in emailed links.
 *
 * Read from the environment rather than derived from the request, because a
 * reset link that points at whatever host the request arrived on is how an
 * attacker redirects a victim to a domain they control.
 */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function verificationUrl(token: string): string {
  return `${appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

export function passwordResetUrl(token: string): string {
  return `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}
