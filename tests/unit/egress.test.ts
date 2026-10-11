/**
 * The address ranges, pinned without a network.
 *
 * Vendored by `shared/sync-guards.sh` next to the scanner it resembles, for the
 * scanner's own reason: `shared/auth/egress.ts` is a policy about one fact — which
 * addresses this server may connect to because a caller named them — and six
 * hand-maintained copies of a range table are six definitions of "internal". The
 * classification is judged here on literals, so it needs no DNS, no listener and no
 * route to wait for; the one case that does need a resolver is a name under `.invalid`,
 * which cannot resolve anywhere by construction.
 *
 * What is pinned, in order: the ranges themselves (including the two a check written
 * from memory tends to forget — 100.64/10, which is how a VPN mesh answers, and
 * `::ffff:`-mapped v4, which is loopback wearing a v6 coat); that a refusal names the
 * field the caller actually sent, because five apps call the same column four things;
 * that a name which will not resolve is refused rather than assumed public; and that
 * the development escape hatch reports itself instead of quietly passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_PRIVATE_ENV, assertAllowedTarget, classifyTarget, isInternalAddress } from "../../src/lib/egress";

const CASES: Array<[string, boolean, string]> = [
  ["127.0.0.1", true, "loopback"],
  ["127.9.9.9", true, "the whole /8, not just .1"],
  ["10.0.0.1", true, "RFC1918"],
  ["172.16.0.1", true, "RFC1918 low edge"],
  ["172.31.255.255", true, "RFC1918 high edge"],
  ["172.32.0.1", false, "one past the range, and public"],
  ["192.168.4.5", true, "RFC1918"],
  ["169.254.169.254", true, "the cloud metadata address"],
  ["169.254.1.1", true, "link-local generally"],
  ["100.64.0.1", true, "CGNAT — how Tailscale answers"],
  ["100.127.255.255", true, "CGNAT high edge"],
  ["100.128.0.1", false, "one past CGNAT"],
  ["0.0.0.0", true, "unspecified"],
  ["192.0.0.1", true, "IETF protocol assignments"],
  ["198.18.0.1", true, "benchmarking"],
  ["8.8.8.8", false, "a real public address"],
  ["93.184.216.34", false, "a real public address"],
  ["::1", true, "v6 loopback"],
  ["::", true, "v6 unspecified"],
  ["fc00::1", true, "unique-local"],
  ["fd12:3456::1", true, "unique-local, the common one"],
  ["fe80::1", true, "v6 link-local"],
  ["fe80::1%eth0", true, "v6 link-local with an interface"],
  ["::ffff:127.0.0.1", true, "v4-mapped loopback"],
  ["::ffff:8.8.8.8", false, "v4-mapped public"],
  ["2606:4700:10::1", false, "a real public v6"],
  ["not-an-ip", true, "unparseable is refused, never guessed at"],
  ["999.1.1.1", true, "out of range is refused too"],
];

test("every address in the table classifies as measured", () => {
  for (const [addr, internal, why] of CASES) {
    assert.equal(isInternalAddress(addr), internal, `${addr} (${why})`);
  }
});

test("a bracketed v6 literal from a URL's hostname is judged, not rejected as a name", () => {
  // `new URL("http://[::1]/").hostname` is `[::1]` with the brackets, and the second
  // form has no port to split on. Both spellings have to reach the v6 branch.
  assert.equal(isInternalAddress("[::1]"), true);
  assert.equal(isInternalAddress("2606:4700:10::1"), false);
});

/** `await` with the env hatch off, restoring whatever it was after. */
async function verdicts(raw: string, label?: string) {
  const had = process.env[ALLOW_PRIVATE_ENV];
  delete process.env[ALLOW_PRIVATE_ENV];
  try {
    return await classifyTarget(raw, label);
  } finally {
    if (had === undefined) delete process.env[ALLOW_PRIVATE_ENV];
    else process.env[ALLOW_PRIVATE_ENV] = had;
  }
}

test("the refusals are the four a caller can act on, in their own words", async () => {
  const bad = await verdicts("not a url at all", "url");
  assert.equal(bad.ok, false);
  assert.equal(bad.code === "unparseable", true);

  for (const [scheme, code] of [["javascript:", "protocol"], ["file:", "protocol"], ["ftp:", "protocol"]] as const) {
    const v = await verdicts(`${scheme}//169.254.169.254/latest/meta-data/`, "url");
    assert.equal(v.ok, false, `${scheme} was accepted`);
    assert.equal(v.code, code);
  }

  // Credentials in the authority are not a webhook contract anyone has, and they are
  // how a spoofed host reads as legitimate in a log line.
  const creds = await verdicts("http://admin:pw@127.0.0.1:6379/", "url");
  assert.equal(creds.ok, false);
  assert.equal(creds.code, "userinfo");

  const internal = await verdicts("http://127.0.0.1:6379/", "webhookUrl");
  assert.equal(internal.ok, false);
  assert.equal(internal.code, "internal");
  // The message is the API's 422 text: it has to name the field the caller sent and
  // the address that decided it, and it has to mention the hatch or a developer on
  // localhost concludes the product is broken rather than that policy is on.
  assert.match(internal.reason, /webhookUrl/);
  assert.match(internal.reason, /127\.0\.0\.1/);
  assert.match(internal.reason, new RegExp(ALLOW_PRIVATE_ENV));
});

test("a public literal needs no resolver, and an unresolvable name is refused", async () => {
  const ok = await verdicts("https://93.184.216.34/hook");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.addresses, ["93.184.216.34"]);

  // `.invalid` is reserved to never resolve, so this proves the fail-closed branch
  // without touching a network: "we could not tell" must not become "so we sent it".
  const dead = await verdicts("https://no-such-host.invalid/hook", "url");
  assert.equal(dead.ok, false);
  assert.equal(dead.ok || dead.code === "dns", true, `expected a dns refusal, got ${JSON.stringify(dead)}`);
});

test("the development hatch lets an internal target through, and marks that it did", async () => {
  const had = process.env[ALLOW_PRIVATE_ENV];
  process.env[ALLOW_PRIVATE_ENV] = "1";
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (m?: unknown) => { warnings.push(String(m)); };
  try {
    const v = await classifyTarget("http://127.0.0.1:6379/", "url");
    assert.equal(v.ok, true, "the hatch does not work");
    assert.equal(v.ok && v.overridden, true, "an allowed-by-hatch target must be reported as such");
    assert.deepEqual(v.ok && v.addresses, ["127.0.0.1"]);
    // Logged at the boundary, not only at the send: a route that stores an internal
    // address under the hatch must say so, or the one trace of the allowance is a
    // warning that only fires if something is later delivered.
    assert.ok(warnings.some((w) => w.includes(ALLOW_PRIVATE_ENV)), "the write-boundary override was honored silently");
  } finally {
    console.warn = realWarn;
    if (had === undefined) delete process.env[ALLOW_PRIVATE_ENV];
    else process.env[ALLOW_PRIVATE_ENV] = had;
  }
});

test("assertAllowedTarget throws with the code, which is what a send site records", async () => {
  const had = process.env[ALLOW_PRIVATE_ENV];
  delete process.env[ALLOW_PRIVATE_ENV];
  try {
    await assert.rejects(() => assertAllowedTarget("http://100.64.1.2:80/status", "issuer"), /internal address/);
    await assert.rejects(
      async () => {
        try {
          await assertAllowedTarget("http://100.64.1.2:80/status", "issuer");
        } catch (e) {
          throw Object.assign(new Error("x"), { egressCode: (e as { egressCode?: string }).egressCode });
        }
      },
      (e: { egressCode?: string }) => e.egressCode === "internal",
    );
    // And the public case returns the parsed URL the caller can use directly.
    const url = await assertAllowedTarget("https://8.8.8.8/hook");
    assert.equal(url.pathname, "/hook");
  } finally {
    if (had === undefined) delete process.env[ALLOW_PRIVATE_ENV];
    else process.env[ALLOW_PRIVATE_ENV] = had;
  }
});
