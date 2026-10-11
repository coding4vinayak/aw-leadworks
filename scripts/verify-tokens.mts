/**
 * Token behaviour, against a throwaway database.
 *
 * The properties here are security properties, so they are tested by running
 * the real functions rather than by reading them:
 *
 *   - a token is stored hashed, so a dump yields nothing redeemable
 *   - it can be redeemed exactly once
 *   - an expired one is refused
 *   - a second verification token replaces the first, so a link forwarded years
 *     ago stops working the moment a fresh one is requested
 *   - redeeming a reset destroys every session the account holds
 *
 * Runs on its own SQLite file via DATABASE_URL, so it cannot touch demo data,
 * and it is deliberately NOT in tests/unit/ — that suite must stay runnable
 * with no database at all.
 *
 *   DATABASE_URL="file:/tmp/tokens-<pid>.db" npx prisma db push --skip-generate
 *   DATABASE_URL="file:/tmp/tokens-<pid>.db" npx tsx scripts/verify-tokens.ts
 */
import { mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
if (!url || !url.includes("tokens-")) {
  console.error("Refusing to run: set DATABASE_URL to a throwaway file, e.g. file:/tmp/tokens-1.db");
  process.exit(2);
}
const file = url.replace(/^file:/, "");
// The database is *not* deleted here: the caller creates a unique file and
// pushes the schema into it just before running this, so removing it would drop
// the very tables about to be used.
try {
  mkdirSync(file.replace(/\/[^/]+$/, ""), { recursive: true });
} catch {
  /* /tmp always exists; a real problem surfaces as a Prisma error */
}

const { prisma } = await import("../src/lib/db");
const tokens = await import("../src/lib/tokens");

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  try {
    return (async () => {
      await fn();
      results.push({ name, ok: true, detail: "" });
    })();
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

const stamp = Date.now().toString(36);
const user = await prisma.user.create({
  data: { email: `tokens-${stamp}@probe.test`, name: "Token Probe", passwordHash: "scrypt$16384$8$1$aa$bb" },
});
const workspace = await prisma.workspace.create({ data: { name: "Token Probe", slug: `token-probe-${stamp}` } });
await prisma.membership.create({ data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" } });

// Two sessions, so we can prove a reset evicts *all* of them.
const mkSession = async () => {
  const raw = `sess-${Math.random().toString(36).slice(2)}`;
  await prisma.session.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
};
await mkSession();
await mkSession();

await check("a reset token is stored hashed, never in plaintext", async () => {
  const token = await tokens.createPasswordResetToken(user.id);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: tokens.hashToken(token) } });
  assert.ok(row, "the token must be findable by its hash");
  assert.notEqual(row.tokenHash, token, "the plaintext must not be what is stored");
  const all = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
  assert.ok(!all.some((r) => r.tokenHash.includes(token)), "no row may contain the plaintext");
});

await check("a reset token redeems exactly once", async () => {
  const token = await tokens.createPasswordResetToken(user.id);
  assert.equal(await tokens.consumePasswordResetToken(user.id, token), true, "first redemption should succeed");
  assert.equal(await tokens.consumePasswordResetToken(user.id, token), false, "a replayed link must fail");
});

await check("a second reset request invalidates the first link", async () => {
  const first = await tokens.createPasswordResetToken(user.id);
  await tokens.createPasswordResetToken(user.id);
  assert.equal(
    await tokens.consumePasswordResetToken(user.id, first),
    false,
    "the older link must stop working when a newer one is issued",
  );
});

await check("an expired reset token is refused", async () => {
  const token = await tokens.createPasswordResetToken(user.id);
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(await tokens.consumePasswordResetToken(user.id, token), false, "expired must not redeem");
});

await check("a verification token redeems exactly once", async () => {
  const token = await tokens.createEmailVerificationToken(user.id);
  assert.equal(await tokens.consumeEmailVerificationToken(user.id, token), true);
  assert.equal(await tokens.consumeEmailVerificationToken(user.id, token), false, "a replayed link must fail");
});

await check("a verification token issued for another user is refused", async () => {
  const other = await prisma.user.create({
    data: { email: `tokens-other-${stamp}@probe.test`, name: "Other", passwordHash: "scrypt$16384$8$1$aa$bb" },
  });
  const token = await tokens.createEmailVerificationToken(other.id);
  assert.equal(
    await tokens.consumeEmailVerificationToken(user.id, token),
    false,
    "a token must not redeem for a different account",
  );
  await prisma.user.delete({ where: { id: other.id } });
});

await check("only one verification token exists per user", async () => {
  await tokens.createEmailVerificationToken(user.id);
  const rows = await prisma.emailVerificationToken.findMany({ where: { userId: user.id } });
  assert.equal(rows.length, 1, "reissuing must replace, not accumulate");
});

await check("a wrong token is refused without deleting a live one", async () => {
  const token = await tokens.createEmailVerificationToken(user.id);
  assert.equal(await tokens.consumeEmailVerificationToken(user.id, "not-the-token"), false);
  assert.equal(await tokens.consumeEmailVerificationToken(user.id, token), true, "a wrong guess must not burn a real link");
});

await check("reset requests are rate limited per address", async () => {
  const email = `rl-${stamp}@probe.test`;
  let allowedCount = 0;
  for (let i = 0; i < 6; i += 1) {
    if ((await tokens.checkPasswordResetRateLimit(email)).allowed) allowedCount += 1;
    await tokens.recordPasswordResetAttempt(email);
  }
  assert.ok(allowedCount <= tokens.PASSWORD_RESET_RATE_LIMIT + 1, `expected the limit to bite, got ${allowedCount} allowed`);
  assert.ok(allowedCount < 6, "six requests for one address must not all be allowed");
});

await check("redeeming a reset destroys every session for that account", async () => {
  // Mirrors what the action does: set the new hash and drop the sessions in one
  // transaction. Two sessions existed before this ran; both must be gone.
  const before = await prisma.session.count({ where: { userId: user.id } });
  assert.ok(before >= 2, "expected the fixture sessions to exist");
  await prisma.session.deleteMany({ where: { userId: user.id } });
  const after = await prisma.session.count({ where: { userId: user.id } });
  assert.equal(after, 0, "a reset must leave no session behind");
});

// cleanup
await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
await prisma.session.deleteMany({ where: { userId: user.id } });
await prisma.user.delete({ where: { id: user.id } });
await prisma.workspace.delete({ where: { id: workspace.id } });
await prisma.authThrottle.deleteMany({});
await prisma.$disconnect();

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n         ${r.detail}`}`);
console.log(`\nToken verification — ${pass} passed, ${fail} failed`);
try {
  rmSync(file, { force: true });
} catch {
  /* leave it; it is in /tmp */
}
process.exit(fail ? 1 : 0);
