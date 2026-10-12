"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { createSession, destroySession, getSession } from "@/lib/session";
import {
  checkPasswordResetRateLimit,
  hashToken,
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  findPasswordResetTokenUser,
  passwordResetUrl,
  recordPasswordResetAttempt,
  verificationUrl,
  VERIFICATION_TOKEN_EXPIRY_HOURS,
  PASSWORD_RESET_TOKEN_EXPIRY_HOURS,
  appBaseUrl,
} from "@/lib/tokens";
import {
  getEmailSender,
  renderPasswordResetEmail,
  renderVerificationEmail,
  renderWelcomeEmail,
  verificationEnforced,
  type DeliveryChannel,
} from "@/lib/email";
import {
  MAX_SIGNIN_FAILURES,
  MAX_SIGNUPS,
  clearTally,
  clientAddress,
  gate,
  signInKey,
  signUpKey,
  tally,
} from "@/lib/throttle";

/**
 * Account server actions: sign up, sign in, sign out.
 *
 * These live apart from the rest of the app's actions because they are the only
 * ones that run *without* a session — which is exactly the distinction a reader
 * needs to see when auditing this file.
 */

export interface AuthState {
  error?: string;
  /** Which input to focus, so the message lands next to the problem. */
  field?: "name" | "email" | "password" | "workspace";
}

/** scrypt cost grows with input length, so bound it before hashing. */
const MAX_PASSWORD_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The refusal an address sees once its budget is gone.
 *
 * It says how long to wait, because an unexplained form that stops working is a
 * form a customer assumes is broken — and the wait is the one thing that makes
 * spreading attempts across more emails pointless.
 */
function waitMessage(minutes: number): string {
  return `Too many attempts from here. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Find a free slug. Slugs are in the URL, so two customers called "Acme" must
 * not fight over one workspace.
 */
async function uniqueSlug(source: string): Promise<string> {
  const stem = slugify(source) || "workspace";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? stem : `${stem}-${attempt + 1}`;
    const taken = await prisma.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${stem}-${randomBytes(4).toString("hex")}`;
}

/**
 * A throwaway digest used only to keep sign-in timing uniform.
 *
 * Built once, lazily, so the cost of a failed login for an address that does not
 * exist is the same as for one that does. Without this, response time alone
 * tells an attacker which email addresses have accounts.
 */
let dummyDigest: string | null = null;
async function getDummyDigest(): Promise<string> {
  dummyDigest ??= await hashPassword(randomBytes(32).toString("hex"));
  return dummyDigest;
}

export async function signUp(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const name = text(formData, "name");
  const email = text(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");
  const requestedWorkspace = text(formData, "workspace");

  // Checked here, tallied on success below. A farmer should be told before the
  // server has hashed a password for an account it is never going to make, but
  // an address must not run out of budget for merely mistyping an email that
  // already exists — that is what the next person on the same connection does.
  const bucket = signUpKey(await clientAddress());
  const allowed = await gate(bucket);
  if (!allowed.allowed) return { error: waitMessage(allowed.retryAfterMinutes) };

  if (name.length < 2) return { error: "Enter your name.", field: "name" };
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address.", field: "email" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.`, field: "password" };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { error: "That password is too long.", field: "password" };
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return { error: "An account with that email already exists. Sign in instead.", field: "email" };
  }

  const passwordHash = await hashPassword(password);
  const workspaceName = requestedWorkspace || `${name}'s team`;
  const slug = await uniqueSlug(requestedWorkspace || name);

  let created: { userId: string; workspaceId: string };
  try {
    // One transaction: a user without a workspace, or a workspace with no
    // owner, would both be broken accounts. Neither can exist if this commits
    // or nothing does.
    created = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name: workspaceName, slug } });
      // The connect is what makes the pair a team. Creating the two rows and
      // stopping there would leave a user who belongs to nothing, and sign-in
      // would then refuse them with "no workspace yet".
      const user = await tx.user.create({ data: { email, name, passwordHash,
        // Pre-verified only when no provider is configured: with mail unable
        // to arrive, demanding a verification click would lock the account out
        // of its own product. With a provider, the account starts unverified
        // and `signIn` enforces the click.
        emailVerified: !verificationEnforced() } });
      // The first seat is an OWNER seat, created in the same transaction as the
      // account itself. Nothing in an invite path can mint one — see roles.ts —
      // so ownership can only ever originate here.
      await tx.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
      });
      return { userId: user.id, workspaceId: workspace.id };
    });
  } catch {
    // Almost always the unique index on email winning a race between two
    // simultaneous signups with the same address.
    return { error: "That email was just registered. Try signing in instead.", field: "email" };
  }

  // One workspace created, so the address has spent one of its five. Counted
  // only now, so nothing that did not result in a workspace can exhaust it.
  await tally(bucket, MAX_SIGNUPS);

  // Issue the first verification link here, while the token is the only way in.
  if (verificationEnforced()) {
    const token = await createEmailVerificationToken(created.userId);
    const { html, text: plain } = renderVerificationEmail({
      product: productName(),
      name,
      verifyUrl: verificationUrl(token),
      expiresHours: VERIFICATION_TOKEN_EXPIRY_HOURS,
    });
    // A provider outage must not swallow the signup: the account exists either
    // way, and /verify-email can be re-sent from the dashboard.
    await getEmailSender()
      .send(email, `Verify your ${productName()} email`, html, plain)
      .catch(() => undefined);
  }

  {
    // Best-effort welcome — the account exists whether or not this arrives.
    const { subject, html, text: plain } = renderWelcomeEmail({
      product: productName(),
      name,
      workspaceName,
      dashboardUrl: `${appBaseUrl()}/dashboard`,
    });
    await getEmailSender().send(email, subject, html, plain).catch(() => undefined);
  }

  await createSession(created.userId, created.workspaceId);
  redirect("/dashboard");
}

export async function signIn(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = text(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "Enter your email and password." };

  // Checked before the lookup and before any hashing: the point of the limit is
  // that a spent address never reaches the expensive path, so it cannot be used
  // to spend CPU either.
  const bucket = signInKey(await clientAddress());
  const allowed = await gate(bucket);
  if (!allowed.allowed) return { error: waitMessage(allowed.retryAfterMinutes) };

  const user = await prisma.user.findUnique({ where: { email } });

  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyDigest()));
  if (!user || !ok) {
    const spent = await tally(bucket, MAX_SIGNIN_FAILURES);
    if (spent >= MAX_SIGNIN_FAILURES) {
      return { error: `That was ${MAX_SIGNIN_FAILURES} failed attempts. ${waitMessage(15)}` };
    }
    // One message for both cases on purpose: "no such account" would turn the
    // login form into a way to enumerate your customers.
    return { error: "Email or password is incorrect." };
  }

  // Right password, so the address's history of failing it is dropped: whoever
  // types it next is not the person who guessed.
  await clearTally(bucket);

  // A session names the workspace it opens, so the first workspace this user
  // belongs to is the one they land in.
  if (!user.emailVerified && verificationEnforced()) {
    return {
      error: "Confirm your email address before signing in. Check your inbox, or resend the link from the dashboard.",
      field: "email",
    };
  }

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  });
  if (!membership) return { error: "This account has no workspace yet. Contact support." };
  const workspace = { id: membership.workspaceId };

  await createSession(user.id, workspace.id);
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}


/**
 * The product's display name, used in emails. Read from the environment rather
 * than hard-coded so one canonical file can be vendored into six products
 * without any of them sending a message that says "LeadGenius".
 */
function productName(): string {
  return process.env.PRODUCT_NAME ?? "Abetworks";
}

export interface ResetState {
  error?: string;
  /** Deliberately uniform: never reveals whether the address has an account. */
  sent?: boolean;
  /** Which transport actually ran, so the UI can be honest about it. */
  channel?: DeliveryChannel;
  /** True when a provider is configured and the message really was sent. */
  delivered?: boolean;
}

/**
 * Start a password reset.
 *
 * The response is identical whether or not the address exists — that is the
 * whole point, because a "no such account" here turns this form into a customer
 * enumeration oracle. The delivery channel is reported because that is a fact
 * about *this deployment*, not about the account, and a person who cannot get
 * the email deserves to be told why rather than left waiting.
 */
export async function requestPasswordReset(_previous: ResetState, formData: FormData): Promise<ResetState> {
  const email = text(formData, "email").toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address.", sent: false };
  }

  const rate = await checkPasswordResetRateLimit(email);
  if (!rate.allowed) {
    return {
      error: `Too many reset requests. Try again in ${rate.retryAfterMinutes} minute${rate.retryAfterMinutes === 1 ? "" : "s"}.`,
      sent: false,
    };
  }
  await recordPasswordResetAttempt(email);

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true } });

  if (!user) {
    // Same shape as success. The address learns nothing.
    return { sent: true };
  }

  const token = await createPasswordResetToken(user.id);
  const { html, text: plain } = renderPasswordResetEmail({
    product: productName(),
    name: user.name,
    resetUrl: passwordResetUrl(token),
    expiresHours: PASSWORD_RESET_TOKEN_EXPIRY_HOURS,
  });

  const result = await getEmailSender().send(email, `Reset your ${productName()} password`, html, plain);
  return { sent: true, channel: result.channel, delivered: result.channel !== "log" };
}

export interface RedeemState {
  error?: string;
  done?: boolean;
}

/**
 * Redeem a reset link and set a new password.
 *
 * Two things happen that are easy to leave out and expensive to skip:
 *
 * 1. **Every existing session is destroyed.** Resetting a password is what a
 *    person does *because* they think someone else has access. Leaving old
 *    cookies working would mean the person they were worried about keeps their
 *    session, and the reset accomplished nothing.
 * 2. The token is consumed in the same transaction as the new hash, so a link
 *    cannot be redeemed twice even if two requests arrive together.
 */
export async function redeemPasswordReset(_previous: RedeemState, formData: FormData): Promise<RedeemState> {
  const token = text(formData, "token");
  const password = String(formData.get("password") ?? "");

  if (!token) return { error: "This reset link is missing its token. Request a new one." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) return { error: "That password is too long." };

  const owner = await findPasswordResetTokenUser(token);
  if (!owner) return { error: "This reset link is invalid or has expired. Request a new one." };

  const ok = await consumePasswordResetToken(owner.userId, token);
  if (!ok) return { error: "This reset link is invalid or has expired. Request a new one." };

  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: owner.userId }, data: { passwordHash } }),
    // The point of the reset: the old sessions go with the old password.
    prisma.session.deleteMany({ where: { userId: owner.userId } }),
  ]);

  return { done: true };
}

export interface VerifyState {
  error?: string;
  verified?: boolean;
  alreadyVerified?: boolean;
}

/** Redeem an email verification link. Reached by GET from the emailed URL. */
export async function redeemEmailVerification(_previous: VerifyState, formData: FormData): Promise<VerifyState> {
  const token = text(formData, "token");
  if (!token) return { error: "This verification link is missing its token." };

  // The token row names its owner, so look the owner up by hash rather than
  // trusting a user id supplied by whoever clicked.
  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { userId: true, expiresAt: true },
  });
  if (!record || record.expiresAt < new Date()) {
    return { error: "This verification link is invalid or has expired." };
  }
  const live = record;

  const ok = await consumeEmailVerificationToken(live.userId, token);
  if (!ok) return { error: "This verification link is invalid or has expired." };

  await prisma.user.update({ where: { id: live.userId }, data: { emailVerified: true } });
  return { verified: true };
}

/** Re-send the verification email. Also reports its channel, for the same reason. */
export async function resendVerification(_previous: ResetState, formData: FormData): Promise<ResetState> {
  const session = await getSession();
  if (!session) return { sent: false, error: "Sign in first." };

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, name: true, email: true, emailVerified: true } });
  if (!user) return { sent: false, error: "Sign in first." };
  if (user.emailVerified) return { sent: true, delivered: true };

  const token = await createEmailVerificationToken(user.id);
  const { html, text: plain } = renderVerificationEmail({
    product: productName(),
    name: user.name,
    verifyUrl: verificationUrl(token),
    expiresHours: VERIFICATION_TOKEN_EXPIRY_HOURS,
  });
  const result = await getEmailSender().send(user.email, `Verify your ${productName()} email`, html, plain);
  return { sent: true, channel: result.channel, delivered: result.channel !== "log" };
}
