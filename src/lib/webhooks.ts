import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import crypto from "crypto";

/**
 * The events this product emits, and the only events a subscription may name.
 *
 * The list exists because the alternative shipped and failed once already in
 * this family: a dispatcher is only half the contract, and a subscription
 * filtered on a name nothing sends is the same silence as no subscription at
 * all — indistinguishable, from the receiver's side, from a correct name for
 * an event that does not exist yet. `unknownEventsProblem` refuses the typo at
 * subscription time, the guard test refuses a declared event with no emitter,
 * and the README documents these three names as the contract. Adding an event
 * is two lines — the name here, the emission there — and the guard fails until
 * both exist.
 */
export const WEBHOOK_EVENTS = ["lead.created", "enrichment.completed", "export.completed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The reason to show the caller, or null when every name is one this product emits. */
export function unknownEventsProblem(requested: string[]): string | null {
  const invalid = requested.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length === 0) return null;
  return `Unknown events: ${invalid.join(", ")}. Valid events: ${WEBHOOK_EVENTS.join(", ")}`;
}

/**
 * Best-effort outbound delivery for leadworks Webhook rows.
 *
 * #17 measured the gap: the Webhook table existed, `api/webhooks/route.ts` let a
 * workspace write one, and nothing in the app ever read those rows back. The check
 * drift's NON_USE declared `egress.ts` present-but-unreachable on the premise that
 * no sender existed; this file is that sender, and the entry retires with it.
 *
 * The policy is the one the vendored egress module states: every address stored in
 * a Webhook row is a caller-named address this process will connect to, so
 * `assertAllowedTarget(hook.url)` sits immediately above the `fetch`, in the same
 * block. That is the shape the egress-sites guard reads as "policy"; anything else
 * (a check hoisted into the loop head, a check on the write boundary only) is what
 * §8.44 measured as being reachable-but-uncovered.
 *
 * Inline, not queued. `src/lib/queue.ts` has scrape/enrich/export/dedupe/validate/
 * scheduled and no `webhook` arm; adding one is a change to the vendored queue
 * module, and a delivery that is best-effort does not need a queue to be best-
 * effort. What it does need is a caller that awaits and never throws, so a webhook
 * outage is a `console.error` and not a 500 the API caller has to reason about.
 * That's `dispatchWebhookEvent`: `Promise.allSettled` over the matching hooks,
 * every per-hook error swallowed here. Retry / dead-letter semantics belong with
 * whoever first needs them; the row set is already the "did the operator ask for
 * this" record.
 */
export async function dispatchWebhookEvent(
  workspaceId: string,
  event: WebhookEvent,
  data: unknown,
): Promise<void> {
  const hooks = await prisma.webhook.findMany({
    where: { workspaceId, isActive: true },
  });
  const matching = hooks.filter((hook) =>
    hook.events.split(",").map((name) => name.trim()).includes(event),
  );
  if (matching.length === 0) return;

  const payload = {
    id: `evt_${crypto.randomBytes(12).toString("base64url")}`,
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  await Promise.allSettled(matching.map((hook) => deliver(hook.id, hook.url, hook.secret, payload)));
}

async function deliver(
  hookId: string,
  rawUrl: string,
  secret: string,
  payload: { id: string; event: string; timestamp: string; data: unknown },
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  try {
    await assertAllowedTarget(rawUrl, "url");
    const response = await fetch(rawUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Leadworks-Signature": signature,
        // The same digest, spelled the way receivers outside this family
        // expect: `sha256=` + hex over the raw body is GitHub's convention and
        // what an inbound nuCRM plugin webhook verifies. The family header
        // stays byte-identical — a receiver that verifies it keeps working,
        // and one that only knows the generic name now does too.
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-Leadworks-Event": payload.event,
        "User-Agent": "Leadworks-Webhook/1.0",
      },
      body,
      // A subscriber that answers with a 3xx is not answered: the redirect is the
      // response. `fetch` follows by default, and the follow is a second address
      // that `assertAllowedTarget` above was never asked about — measured as a
      // subscription whose endpoint replied 302 to `http://127.0.0.1:8096/stolen`,
      // a target every write door refuses, which the delivery then requested (as a
      // GET, the body and the id dropped at the hop, the event header carried
      // through). The scrape path already asks once per page it navigates to; this
      // is the same rule at the same granularity, one ask per connect.
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`webhook ${hookId} -> ${payload.event}: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`webhook ${hookId} -> ${payload.event} failed:`, error);
  }
}
