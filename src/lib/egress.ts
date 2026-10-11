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

function isInternalV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;                    // loopback
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true; // unspecified
  if (/^::ffff:/.test(lower) || /^::/.test(lower)) {
    // v4-mapped (and the compat form): judge the IPv4 inside it, because a wall that
    // reads `::ffff:127.0.0.1` as public is a wall with a door in it.
    const tail = lower.replace(/^::ffff:/, "").replace(/^:*/, "");
    if (octets(tail)) return isInternalV4(tail);
  }
  const head = lower.split(":")[0] ?? "";
  const word = head === "" ? 0 : parseInt(head, 16);
  if (Number.isNaN(word)) return true;                 // not a parseable v6 literal
  if ((word & 0xfe00) === 0xfc00) return true;         // fc00::/7 unique-local
  if ((word & 0xffc0) === 0xfe80) return true;         // fe80::/10 link-local
  if ((word & 0xffc0) === 0x2000 && (word & 0x0002) === 0) return false; // documentation, public
  return false;
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
  const where = host && host !== addr ? `${host} resolves to ${addr}` : addr;
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
