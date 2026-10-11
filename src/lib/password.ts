import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing, deliberately built on `node:crypto` instead of a native
 * addon.
 *
 * bcrypt and argon2 both need a compiled dependency. That would cost this
 * product the property that makes it easy to sell and easy to self-host: it
 * runs anywhere Node runs, with no native toolchain and no rebuild when the
 * host's Node version changes. scrypt ships inside Node, is memory-hard, and is
 * what the Node documentation recommends for password storage — so it is the
 * hash that costs nothing to adopt and nothing to deploy.
 *
 * The stored value is self-describing, so the work factor can be raised later
 * without invalidating anyone's existing password:
 *
 *     scrypt$<N>$<r>$<p>$<salt>$<digest>
 */

const N = 16384; // CPU/memory cost (~16 MB, ~50-100ms per verification).
const R = 8; // Block size.
const P = 1; // Parallelisation.
const KEYLEN = 64;
const SALT_BYTES = 16;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function derive(password: string, salt: string, keylen: number, params: ScryptParams) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      // Normalise first: an accented character typed on one keyboard must match
      // the same character typed on another, or the user is locked out by their
      // own password.
      password.normalize("NFKC"),
      salt,
      keylen,
      {
        ...params,
        // scrypt needs 128 * N * r bytes, and Node's default ceiling (32 MB) is
        // only just above what we ask for here. Raise it explicitly so future
        // tuning of N fails loudly on our own terms rather than at 2 a.m.
        maxmem: 256 * 1024 * 1024,
      },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const digest = await derive(password, salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt, digest.toString("base64url")].join("$");
}

/**
 * Verify a password against a stored digest.
 *
 * Returns false for anything malformed rather than throwing: a corrupt or
 * hand-edited row must read as "wrong password", not as a 500 that tells an
 * attacker which account has an unusual half-written record.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, rawN, rawR, rawP, salt, rawDigest] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  // An integer check alone is not enough. `N=0` and `N=1` are integers, and node
  // answers N=0 by falling back to its own default (16384) rather than failing
  // — so a hand-edited or corrupt work factor would silently verify against
  // parameters nobody wrote down. The whole point of the self-describing format
  // is that the recorded cost is the cost used, so scrypt's own rule is enforced
  // here: N a power of two above 1, r and p at least 1.
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1) return false;
  if (!Number.isInteger(p) || p < 1) return false;
  // Refuse a digest so large that verifying it becomes a denial-of-service: the
  // key length is bounded long before this (64 bytes today).
  if (rawDigest.length > 256) return false;
  const params: ScryptParams = { N, r, p };

  let expected: Buffer;
  try {
    expected = Buffer.from(rawDigest, "base64url");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const actual = await derive(password, salt, expected.length, params);

  // Constant-time comparison: a byte-by-byte early exit leaks how much of the
  // digest matched, which is enough to reconstruct a password one byte at a
  // time. Lengths are compared first because timingSafeEqual throws otherwise.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
