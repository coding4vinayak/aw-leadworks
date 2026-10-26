/**
 * Where this server is allowed to make a request because a caller told it to.
 *
 * Vendored by `shared/sync-auth.sh` into every app, for the reason the rest of this
 * directory exists: the rule is about the network this product runs on, which is one
 * fact, and six copies of it would be six definitions of "internal" — the same shape
 * of mistake §8.44 found on the argument axis, where four apps read the same call four
 * ways.
 *
 * Seven call sites in five apps were measured before this file was written, and they
 * are what makes it one module rather than five conditionals:
 *
 *   abetapi        `dispatch.ts:83`     POSTs a signed payload to `Webhook.url`
 *   abetapi        `sso.ts:33`          GETs `SsoConfig.metadataUrl`, parses the reply
 *   abetanalytics  `alerts.ts:43`       POSTs to `AlertRule.webhookUrl`
 *   leadgenius     `webhooks.ts:11`     POSTs to `Webhook.url`
 *   abetagent      `tools.ts:50,85`     `http_fetch` takes the URL from the model's own
 *                                      tool arguments and puts up to 4 000 characters of
 *                                      the response into the agent's context
 *   abetflow       `executor.ts:129`    the `http_request` node fetches a URL rendered
 *                                      out of the workflow definition — and #74/#75 say a
 *                                      public webhook trigger can supply that input
 *
 * The common shape is a *stored or model-supplied address that this process connects
 * to*, and the property those five need is the same one: not "is this a well-formed URL"
 * (`format: "url"` in `validate.ts` has answered that since §8.17, and answers it the
 * same way for `http://127.0.0.1:6379/`) but "is this a place the caller could not
 * reach from outside, and would not have been able to reach at all if the server were
 * not doing the fetching for them".
 *
 * So the rule is address-shaped, and it is checked twice. At the boundary that stores
 * the address, where a refusal is a 4xx a caller can act on — 422 in abetapi and
 * abetanalytics, 400 in leadgenius and abetagent, because those two apps' `fail()`
 * envelope is older than the split and #28 is where that disagreement lives, not here.
 * And at the moment of sending, where rows that predate this rule and rows whose name
 * has since been re-pointed by DNS still get refused. The two checks are the same
 * function; the second is why the first is not enough on its own.
 *
 * The gap that is left is stated in `shared/README.md` rather than papered over: this
 * resolves the name, looks at every answer, and then hands the *name* to `fetch`,
 * which resolves again. Closing that means connecting to the address that was checked,
 * which no caller of `fetch` can do without a custom agent — recorded as owed.
 */

/** Set to 1 in a development checkout to allow an internal target. Off by default. */
export const ALLOW_PRIVATE_ENV = "ABET_ALLOW_PRIVATE_TARGETS";

export type Refusal = {
  ok: false;
  /** Stable code for a log or a test: not a sentence a caller has to parse. */
  code: "protocol" | "host" | "userinfo" | "internal" | "dns" | "unparseable";
  reason: string;
};

export type Verdict = { ok: true; url: URL; addresses: string[]; overridden: boolean } | Refusal;

/**
 * Is this IP address somewhere a caller could not get to on their own?
 *
 * Exported separately because the ranges are the whole content of the policy and they
 * have to be testable without a network: `classifyTarget` needs DNS, this does not.
 */
export function isInternalAddress(ip: string): boolean {
  const addr = ip.trim().replace(/^\[(.*)\]$/, "$1");
  const scope = addr.indexOf("%"); // fe80::1%eth0 — the interface is not part of the address
  const bare = scope === -1 ? addr : addr.slice(0, scope);

  if (bare.includes(":")) return isInternalV6(bare);
  return isInternalV4(bare);
}

function octets(v4: string): number[] | null {
  const parts = v4.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isInternalV4(ip: string): boolean {
  const n = octets(ip);
  if (!n) return true; // not a parseable v4 literal: refuse it, do not guess
  const [a, b] = n;
  if (a === 0) return true;                            // 0.0.0.0/8 "this network", incl. unspecified
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                           // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;    // RFC1918
  if (a === 192 && b === 168) return true;             // RFC1918
  if (a === 169 && b === 254) return true;             // link-local — and 169.254.169.254, the cloud
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT / most VPN meshes (100.64/10)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 0 && n[2] === 0) return true;  // 192.0.0/24 IETF protocol assignments
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 literal, or `null` when it does not parse.
 *
 * Written out rather than borrowed because the answer this file needs is the group
 * vector, not a string: four IPv6 forms carry an IPv4 address inside them, and none
 * of them can be recognised by a prefix test on the text once a URL parser has had
 * its say (`new URL("http://[::ffff:127.0.0.1]/").hostname` is
 * `[::ffff:7f00:1]` — the same address, in the one spelling the text test never saw).
 * A trailing dotted quad is accepted and folded into the last two groups.
 */
function v6Groups(ip: string): number[] | null {
  let work = ip;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(work);
  if (dotted) {
    const n = octets(dotted[1]);
    if (!n) return null;
    const hi = (n[0] << 8) | n[1];
    const lo = (n[2] << 8) | n[3];
    work = work.slice(0, dotted.index) + hi.toString(16) + ":" + lo.toString(16);
  }

  const words = (run: string): number[] | null => {
    if (run === "") return [];
    const out: number[] = [];
    for (const part of run.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  const halves = work.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const all = words(work);
    return all && all.length === 8 ? all : null;
  }
  const head = words(halves[0] ?? "");
  const tail = words(halves[1] ?? "");
  if (!head || !tail) return null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null; // `::` stands for at least one zero group, or the literal is a lie
  return [...head, ...Array.from({ length: gap }, () => 0), ...tail];
}

/**
 * The IPv4 an IPv6 literal carries, when its form is one that carries one.
 *
 * Four forms do, and #55 measured all four arriving at a write door on this box,
 * each of them handed to `fetch` as a public address while the dotted spelling of
 * the same target was refused: v4-mapped (`::ffff:x:y`, and the expanded
 * `0:0:0:0:0:ffff:x:y`), v4-compatible (`::x:y`), the NAT64 well-known prefix
 * (`64:ff9b::x:y`) and 6to4 (`2002:x:y::`). `::ffff:127.0.0.1` was already judged
 * here; what was not, is the address after the URL parser has normalised it, and the
 * parser normalises every one of them.
 *
 * Judging the embedded address is not a v6 blanket ban: `::ffff:8.8.8.8` and
 * `2002:0808:0808::` carry a public IPv4 and stay public, exactly as the dotted form
 * does. A form that carries nothing falls through to the v6 ranges below.
 */
function embeddedV4(groups: number[]): string | null {
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  const quad = (hi: number, lo: number) => `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  if (zeros(0, 5) && groups[5] === 0xffff) return quad(groups[6], groups[7]); // v4-mapped
  if (zeros(0, 6)) return quad(groups[6], groups[7]); // v4-compatible
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && zeros(2, 6)) return quad(groups[6], groups[7]); // NAT64, 64:ff9b::/96
  if (groups[0] === 0x2002) return quad(groups[1], groups[2]); // 6to4, 2002::/16
  return null;
}

/**
 * Why a v6 literal is internal, as the address the refusal should name: the literal
 * itself when it sits in a v6 range, the wrapped IPv4 when a carrying prefix is what
 * makes it internal. `null` is public.
 *
 * The decision and the explanation come out of one function because #55's first draft
 * split them: `[::1]` was refused for being the v6 loopback while the message printed
 * the v4-compatible reading of the same eight groups, `0.0.0.1`, sending an operator to
 * chase an address nobody wrote.
 */
function internalV6(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower === "::1") return lower;                    // loopback
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return lower; // unspecified
  const groups = v6Groups(lower);
  if (!groups) return lower;                            // not a parseable v6 literal: refuse, do not guess
  const word = groups[0];
  if ((word & 0xfe00) === 0xfc00) return lower;         // fc00::/7 unique-local
  if ((word & 0xffc0) === 0xfe80) return lower;         // fe80::/10 link-local
  const inside = embeddedV4(groups);
  // An IPv4 wearing a v6 coat is still that IPv4 — including the coat a URL parser
  // puts on it between the caller's string and this function.
  if (inside) return isInternalV4(inside) ? inside : null;
  return null; // 2001:db8:: documentation, 2000::/3 aggregator space, everything else: public
}

function isInternalV6(ip: string): boolean {
  return internalV6(ip) !== null;
}

/** Every internal reason a URL can fail, in the order a caller can act on them. */
function protocolRefusal(url: URL): Refusal | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "protocol", reason: `${url.protocol} is not a scheme this server will request` };
  }
  if (!url.hostname) return { ok: false, code: "host", reason: "no host in the URL" };
  // `http://admin@127.0.0.1/` — userinfo is not part of any webhook contract this
  // family has, and it is how a spoofed host looks legitimate.
  if (url.username || url.password) {
    return { ok: false, code: "userinfo", reason: "a URL with credentials in it is not an address we will fetch" };
  }
  return null;
}

/**
 * The policy, as a question about one string.
 *
 * `label` is the word the 422 should use for the field (`url`, `webhookUrl`, `issuer`),
 * because five apps name the same column four different things and a message that says
 * "url" about a field called `webhookUrl` is a message nobody can act on.
 */
/**
 * The one shape an override is allowed to take: a verdict that says "go," after
 * saying out loud that the hatch is what let it through. Every honored override
 * runs through here, so a write-boundary `classifyTarget` logs the same warning a
 * send-time `assertAllowedTarget` does — the routes classify and the senders assert,
 * but a development-only allowance that is silent at the boundary is only half kept.
 */
function allowOverride(url: URL, addresses: string[]): Verdict {
  console.warn(`egress: ${ALLOW_PRIVATE_ENV} is set — ${url.origin} allowed despite internal addresses ${addresses.join(", ") || "unresolved"}`);
  return { ok: true, url, addresses, overridden: true };
}

export async function classifyTarget(raw: string, label = "url"): Promise<Verdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "unparseable", reason: `${label} is not an absolute URL` };
  }

  const bad = protocolRefusal(url);
  if (bad) return bad;

  const overridden = /^(1|true|yes)$/i.test(process.env[ALLOW_PRIVATE_ENV] ?? "");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");

  if (isIpAddress(host)) {
    if (isInternalAddress(host)) {
      if (!overridden) return { ok: false, code: "internal", reason: internalRefusal(label, host) };
      return allowOverride(url, [host]);
    }
    return { ok: true, url, addresses: [host], overridden: false };
  }

  // A name is judged by every address it answers with, not the first: a hostname with
  // one public answer and one `127.0.0.1` is a way through a check that looked only at
  // the first. DNS failing is a refusal, not a pass — the alternative is that a
  // network outage turns into "we could not tell, so we sent it".
  let answers: Array<{ address: string }>;
  try {
    const dns = await import("node:dns/promises");
    answers = await dns.lookup(host, { all: true });
  } catch (e) {
    if (overridden) return allowOverride(url, []);
    return {
      ok: false,
      code: "dns",
      reason: `${label} host ${host} could not be resolved (${e instanceof Error ? e.message : "unknown"}), and an unresolvable address is refused rather than assumed public`,
    };
  }
  if (!answers.length) return { ok: false, code: "dns", reason: `${label} host ${host} resolved to nothing` };

  const addresses = answers.map((a) => a.address);
  const internal = addresses.find((a) => isInternalAddress(a));
  if (internal) {
    if (!overridden) return { ok: false, code: "internal", reason: internalRefusal(label, internal, host) };
    return allowOverride(url, addresses);
  }
  return { ok: true, url, addresses, overridden: false };
}

function isIpAddress(host: string): boolean {
  return octets(host) !== null || host.includes(":");
}

function internalRefusal(label: string, addr: string, host?: string): string {
  const carried = addr.includes(":") ? internalV6(addr) : null;
  const named = carried && carried !== addr ? `${addr} carries ${carried}` : addr;
  const where = host && host !== addr ? `${host} resolves to ${named}` : named;
  return `${label} must not be an internal address (${where}). This server requests the address you name, so a target on its own network, a VPN mesh or the cloud metadata address is a request you could not make yourself. Set ${ALLOW_PRIVATE_ENV}=1 in a development checkout to allow it.`;
}

/**
 * The send-time form: same policy, and it throws instead of returning a verdict,
 * because a caller that is about to `fetch` has no branch to put a verdict in — the
 * refusal is the outcome. `never throws` is not claimed: the sites that catch around
 * their own fetch record this as a failed delivery, which is what they already do for
 * a connection error.
 */
export async function assertAllowedTarget(raw: string, label = "url"): Promise<URL> {
  const verdict = await classifyTarget(raw, label);
  if (verdict.ok) {
    // The override warning already fired inside `classifyTarget` — this is the same
    // call the routes make, so it is logged once whichever side of the boundary it
    // is honored on.
    return verdict.url;
  }
  throw Object.assign(new Error(verdict.reason), { egressCode: verdict.code });
}
