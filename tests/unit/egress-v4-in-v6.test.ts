/**
 * #55 — the IPv4 an IPv6 literal carries.
 *
 * `src/lib/egress.ts` judges an address, and every caller in this product hands it
 * the address through `new URL(...)`. That parser rewrites an IPv6 literal into its
 * compressed hex form on the way, and the rewrite is the whole defect: measured on a
 * running instance with the policy at its default, `http://127.0.0.1:8097/ok` was
 * refused at `POST /api/webhooks` with 400 while `http://[::ffff:127.0.0.1]:8097/ok`
 * was stored as `[::ffff:7f00:1]` and answered 201 — the same loopback, in the one
 * spelling the guard had no branch for. Three of the six accepted spellings then put
 * a real signed `lead.created` on a loopback listener; the metadata address in the
 * same coat (`[::ffff:a9fe:a9fe]`) was accepted too, and deleted before a single lead
 * existed so nothing was ever delivered there.
 *
 * The pre-existing suite already asserted `::ffff:127.0.0.1` is internal — as a bare
 * string, which is the form no caller ever produces. Those cases are kept, and the
 * first test here is the reason they were not enough.
 *
 * Nothing in this file needs a network, a listener or a database: an IP literal is
 * classified without a resolver, and the delivery-side claims are read out of the
 * source of the two files that hold them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOW_PRIVATE_ENV, assertAllowedTarget, classifyTarget, isInternalAddress } from "../../src/lib/egress";
import { blankComments, functionBody } from "./route-handlers";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const deliverySource = read("../../src/lib/webhooks.ts");
const scrapeSource = read("../../src/lib/scraper.ts");

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

/** The host a caller's URL leaves behind — the string the guard is really asked about. */
function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
}

// Every row is a press taken against the base build on :3351, where the door answered
// 201 and kept the left column verbatim: ten internal targets, each written in a coat
// the guard had no branch for. All ten went through the same door on the fixed build
// and each came back 400 (`/tmp/opencode/r55_after.log`).
const COATED: Array<[string, string, string]> = [
  ["http://[::ffff:127.0.0.1]:8097/ok", "127.0.0.1", "v4-mapped, dotted — the caller's spelling"],
  ["http://[::ffff:7f00:1]:8097/ok", "127.0.0.1", "v4-mapped, hex — what the URL parser leaves"],
  ["http://[0:0:0:0:0:ffff:7f00:1]:8097/ok", "127.0.0.1", "v4-mapped, uncompressed"],
  ["http://[::7f00:1]:8097/ok", "127.0.0.1", "v4-compatible"],
  ["http://[64:ff9b::7f00:1]:8097/ok", "127.0.0.1", "NAT64 well-known prefix"],
  ["http://[2002:7f00:1::]:8097/ok", "127.0.0.1", "6to4"],
  ["http://[::ffff:a9fe:a9fe]/latest/meta-data/", "169.254.169.254", "the cloud metadata address"],
  ["http://[::ffff:0a00:0052]:6379/", "10.0.0.82", "this box's own RFC1918 address, at its Redis port"],
  ["http://[::ffff:c0a8:0405]:8097/ok", "192.168.4.5", "a host on an RFC1918 network"],
  ["http://[::ffff:6440:0001]:8097/ok", "100.64.0.1", "a VPN mesh address"],
];

test("the parser, not the caller, decides which spelling the guard sees", () => {
  // The reason a test over bare strings could pass while the door stood open: these
  // two hostnames are the same address, and only one of them was ever written.
  assert.equal(hostOf("http://[::ffff:127.0.0.1]:8097/ok"), "::ffff:7f00:1");
  assert.equal(hostOf("http://[0:0:0:0:0:ffff:7f00:1]:8097/ok"), "::ffff:7f00:1");
  assert.equal(isInternalAddress("::ffff:127.0.0.1"), true, "the bare string was already refused");
  assert.equal(isInternalAddress("::ffff:7f00:1"), true, "and so is the string the parser produces");
});

test("every coat that reached the door is judged by the address inside it", () => {
  for (const [url, embedded, why] of COATED) {
    assert.equal(isInternalAddress(hostOf(url)), true, `${why}: ${url} was read as public`);
    assert.ok(hostOf(url).includes(":"), `${url} is not an IPv6 literal`);
    assert.equal(isInternalAddress(embedded), true, `${embedded} is not internal on its own either`);
  }
});

test("the four forms that carry an IPv4 are each covered, for loopback", () => {
  const forms = ["::ffff:7f00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::"];
  assert.deepEqual(forms.filter((f) => !isInternalAddress(f)), [], "one of the four forms is still public");
});

test("a refusal says which literal arrived and which address it carries", async () => {
  const verdict = await verdicts("http://[::ffff:7f00:1]:8097/ok", "url");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code === "internal", true, `expected an internal refusal, got ${JSON.stringify(verdict)}`);
  if (verdict.ok) return;
  // Both halves are in the message because the caller wrote one and the parser sent
  // the other: a refusal that quotes only `127.0.0.1` about a URL written in v6 is a
  // message nobody can find the row with.
  assert.match(verdict.reason, /::ffff:7f00:1/);
  assert.match(verdict.reason, /carries 127\.0\.0\.1/);
  assert.match(verdict.reason, new RegExp(ALLOW_PRIVATE_ENV));
});

test("a refusal names the reason an address is internal, not merely a number inside it", async () => {
  // `[::1]` is eight groups whose v4-compatible reading is `0.0.0.1`. It is refused
  // because it is the v6 loopback, and the first draft of this fix printed `0.0.0.1`
  // at the door — a true fact about bits and a false fact about the reason.
  const loopback = await verdicts("http://[::1]:8097/ok", "url");
  assert.equal(loopback.ok, false);
  if (loopback.ok) return;
  assert.match(loopback.reason, /\(::1\)/);
  assert.doesNotMatch(loopback.reason, /carries/, "a v6 range answer has no IPv4 to blame");

  for (const ip of ["fd12::1", "fe80::1"]) {
    const verdict = await verdicts(`http://[${ip}]:8097/ok`, "url");
    assert.equal(verdict.ok, false, `${ip} is unique-local or link-local`);
    if (verdict.ok) continue;
    assert.match(verdict.reason, new RegExp(ip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(verdict.reason, /carries/, `${ip} is internal as a v6 address`);
  }
});

test("the coated metadata address is refused at the boundary, before any socket", async () => {
  const verdict = await verdicts("http://[::ffff:a9fe:a9fe]/latest/meta-data/", "url");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code === "internal", true);
  if (verdict.ok) return;
  assert.match(verdict.reason, /169\.254\.169\.254/);
});

test("each measured press is refused by classifyTarget, in the label the caller sent", async () => {
  for (const [url, , why] of COATED) {
    const verdict = await verdicts(url, "webhookUrl");
    assert.equal(verdict.ok, false, `${why}: the door would have stored ${url}`);
    assert.equal(verdict.code === "internal", true, `${why}: refused for the wrong reason — ${JSON.stringify(verdict)}`);
    if (!verdict.ok) assert.match(verdict.reason, /webhookUrl/);
  }
});

test("a coat around a public IPv4 stays public — this is not a ban on the form", async () => {
  for (const [host, addr] of [
    ["::ffff:808:808", "8.8.8.8"],
    ["::ffff:8.8.8.8", "8.8.8.8"],
    ["64:ff9b::0808:0808", "8.8.8.8"],
    ["2002:0808:0808::", "8.8.8.8"],
    ["::ffff:5d9b:d822", "93.184.216.34"],
  ] as const) {
    assert.equal(isInternalAddress(host), false, `${host} carries ${addr}, which is public`);
  }
  const verdict = await verdicts("https://[::ffff:808:808]/hook");
  assert.equal(verdict.ok, true, "a public address in a v6 coat must still be a target");
});

test("a v6 address that carries nothing keeps every answer it had", () => {
  for (const [ip, internal] of [
    ["2001:db8::1", false],
    ["2606:4700:10::1", false],
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["fe80::1%eth0", true],
  ] as const) {
    assert.equal(isInternalAddress(ip), internal, ip);
  }
});

test("a literal that does not parse is refused in either family, not guessed at", () => {
  for (const ip of ["gg00::1", "1:2:3:4:5:6:7:8:9", ":::", "1:2:3:4:5:6:7", "127.0.0.0.1", "0x7f.0.0.1"]) {
    assert.equal(isInternalAddress(ip), true, `${ip} was let through as public`);
  }
});

test("an expanded literal and a dotted tail are read group by group", () => {
  assert.equal(isInternalAddress("0:0:0:0:0:ffff:7f00:1"), true);
  assert.equal(isInternalAddress("0:0:0:0:0:0:7f00:1"), true);
  assert.equal(isInternalAddress("0:0:0:0:0:ffff:808:808"), false);
  assert.equal(isInternalAddress("64:ff9b::192.168.1.1"), true);
  assert.equal(isInternalAddress("2002:7f00:1::"), true);
});

test("the hatch carries a coated address through, and still reports itself", async () => {
  const had = process.env[ALLOW_PRIVATE_ENV];
  process.env[ALLOW_PRIVATE_ENV] = "1";
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (m?: unknown) => { warnings.push(String(m)); };
  try {
    const verdict = await classifyTarget("http://[::ffff:7f00:1]:8097/ok", "url");
    assert.equal(verdict.ok, true, "a development checkout must be able to name itself");
    assert.equal(verdict.ok && verdict.overridden, true);
    assert.ok(warnings.some((w) => w.includes(ALLOW_PRIVATE_ENV)), "the hatch was honored silently");
  } finally {
    console.warn = realWarn;
    if (had === undefined) delete process.env[ALLOW_PRIVATE_ENV];
    else process.env[ALLOW_PRIVATE_ENV] = had;
  }
});

test("the send site throws with the code a delivery log records", async () => {
  const had = process.env[ALLOW_PRIVATE_ENV];
  delete process.env[ALLOW_PRIVATE_ENV];
  try {
    await assert.rejects(
      () => assertAllowedTarget("http://[::ffff:7f00:1]:8097/ok", "url"),
      /must not be an internal address/,
    );
    const code = await assertAllowedTarget("http://[::ffff:7f00:1]:8097/ok", "url").catch(
      (e: unknown) => (e as { egressCode?: string }).egressCode,
    );
    assert.equal(code, "internal", "a coated refusal must reach the log as the same code a dotted one does");
  } finally {
    if (had === undefined) delete process.env[ALLOW_PRIVATE_ENV];
    else process.env[ALLOW_PRIVATE_ENV] = had;
  }
});

test("the coat does not change the range table's answers", () => {
  // Every v4 range the dotted table already refuses, in the hex form a URL leaves
  // behind. The pair is the point: the same address, judged the same way, in both
  // spellings — a policy that only knows one of them is a policy with a door in it.
  const RANGES: Array<[string, string, string]> = [
    ["127.9.9.9", "::ffff:7f09:0909", "loopback /8, not just .1"],
    ["10.255.0.7", "::ffff:0aff:0007", "RFC1918"],
    ["172.16.0.1", "::ffff:ac10:0001", "RFC1918 low edge"],
    ["172.31.255.255", "::ffff:ac1f:ffff", "RFC1918 high edge"],
    ["192.168.4.5", "::ffff:c0a8:0405", "RFC1918"],
    ["169.254.169.254", "::ffff:a9fe:a9fe", "link-local and the cloud address"],
    ["100.64.0.1", "::ffff:6440:0001", "CGNAT — how a VPN mesh answers"],
    ["100.127.255.255", "::ffff:647f:ffff", "CGNAT high edge"],
    ["0.0.0.0", "::", "unspecified"],
    ["192.0.0.1", "::ffff:c000:0001", "IETF protocol assignments"],
    ["198.18.0.1", "::ffff:c612:0001", "benchmarking"],
    ["172.32.0.1", "::ffff:ac20:0001", "one past RFC1918, and public"],
    ["100.128.0.1", "::ffff:6480:0001", "one past CGNAT, and public"],
  ];
  for (const [dotted, hex, why] of RANGES) {
    assert.equal(isInternalAddress(dotted), isInternalAddress(hex), `${why}: ${dotted} and ${hex} disagreed`);
  }
  assert.equal(isInternalAddress("::ffff:ac20:0001"), false, "the public side stayed public");
});

test("a v6 coat whose groups would be a lie is refused, not decoded", () => {
  // `::` that stands for nothing, a tail that is not two groups, a host that is not a
  // host. The alternative is a parse that guesses, and a guess here is an allow.
  for (const ip of ["::ffff:", "1:2:3:4:5:6:7:8:9", "::1::2", "::::", "::ffff:gg00:1"]) {
    assert.equal(isInternalAddress(ip), true, `${ip} was read as public`);
  }
});

test("every coated press the door took is refused at the boundary", async () => {
  // The six spellings pressed against `POST /api/webhooks` on the base build, plus the
  // private ranges they stand for — each one through the function the routes call, so
  // the table is pinned against the policy and not against this file's memory.
  for (const [url, embedded] of COATED) {
    const verdict = await verdicts(url, "url");
    assert.equal(verdict.ok, false, url);
    if (!verdict.ok) assert.ok(verdict.reason.includes(embedded), `${url} should name ${embedded}`);
  }
});

test("the delivery fetch follows no redirect, because the guard was asked about one address", () => {
  const body = functionBody(deliverySource, "deliver");
  assert.ok(body, "deliver() was not found in src/lib/webhooks.ts");
  const withoutComments = blankComments(body!);
  assert.match(withoutComments, /redirect:\s*"manual"/, "a 3xx would be re-requested without asking the policy");
  assert.equal(
    (withoutComments.match(/redirect:/g) ?? []).length,
    1,
    "one redirect decision per delivery, not a second policy",
  );
  // The ask is above the fetch, in the same function: the refusal is about the address
  // this call connects to, and a check that ran after would be a report, not a guard.
  assert.ok(
    withoutComments.indexOf("assertAllowedTarget") < withoutComments.indexOf("fetch("),
    "the egress ask must come before the connect",
  );
});

test("a 3xx is left as the response it is, which is what the delivery already reports", () => {
  const body = functionBody(deliverySource, "deliver");
  assert.ok(body);
  assert.match(blankComments(body!), /if \(!response\.ok\)/, "a non-2xx answer is logged, and 302 is one now");
});

test("one ask per connect is the shape the scrape path already had", () => {
  // `src/lib/scraper.ts` re-checks every page it navigates to, which is why the
  // delivery path's single ask is a gap rather than a house style. Pinned so a future
  // "optimisation" that drops one of them is a decision and not an oversight.
  const asks = (scrapeSource.match(/assertAllowedTarget\(/g) ?? []).length;
  assert.equal(asks, 2, "the config URL and each built page URL are both caller-named addresses");
});

test("no other fetch in the delivery module inherits the unchecked redirect", () => {
  const withoutComments = blankComments(deliverySource);
  const fetches = (withoutComments.match(/\bfetch\(/g) ?? []).length;
  const redirects = (withoutComments.match(/redirect:/g) ?? []).length;
  assert.equal(fetches, 1, "one outbound fetch is enough");
  assert.equal(redirects, 1, "and it states its redirect policy");
});
