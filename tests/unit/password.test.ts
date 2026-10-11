// Password hashing, offline. The bug this file exists to prevent: a verify
// that throws on a wrong password turns every failed login into a 500, and one
// that returns false for a malformed digest lets a corrupt row read as a
// correct password.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../../src/lib/password";

describe("hashPassword", () => {
  it("never stores the password and records its own work factor", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.ok(!stored.includes("correct horse"));
    const [scheme, n, r, p, salt, digest] = stored.split("$");
    assert.equal(scheme, "scrypt");
    assert.equal(n, "16384");
    assert.equal(r, "8");
    assert.equal(p, "1");
    assert.ok(salt.length > 8, "a real salt is stored alongside the digest");
    assert.ok(digest.length > 32);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same-password-123", a), true);
    assert.equal(await verifyPassword("same-password-123", b), true);
  });

  it("survives a Unicode keyboard difference: NFKC-normalised, not raw bytes", async () => {
    // "é" typed as one code point must verify against the decomposed form,
    // or a user locks themselves out with their own password.
    const stored = await hashPassword("café-passphrase");
    assert.equal(await verifyPassword("café-passphrase", stored), true);
  });
});

describe("verifyPassword", () => {
  it("returns false for a wrong password instead of throwing", async () => {
    // The failure mode that made the previous hand-rolled version unusable:
    // timingSafeEqual throws when the two buffers differ in length, so any
    // wrong password produced a 500 instead of a refusal.
    const stored = await hashPassword("the-right-password");
    for (const attempt of ["wrong", "", "the-right-passwore", "x".repeat(500)]) {
      assert.equal(await verifyPassword(attempt, stored), false, `"${attempt}" must read as wrong`);
    }
  });

  it("returns false — not a throw — for a malformed or truncated digest", async () => {
    for (const bad of [
      "",
      "not-a-digest",
      "salt:hash",
      "scrypt$16384$8$1$onlysalt",
      "bcrypt$16384$8$1$salt$digest",
      "scrypt$abc$8$1$salt$digest",
      "scrypt$16384$8$1$$",
    ]) {
      assert.equal(await verifyPassword("anything", bad), false, `malformed digest accepted: "${bad}"`);
    }
  });

  it("refuses a digest whose work factor is not an integer", async () => {
    // Otherwise a hand-edited row could set N to something absurd.
    const stored = await hashPassword("password-1234");
    const parts = stored.split("$");
    parts[1] = "0";
    assert.equal(await verifyPassword("password-1234", parts.join("$")), false);
  });
});
