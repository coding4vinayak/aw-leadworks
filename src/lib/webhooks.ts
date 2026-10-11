import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import crypto from "crypto";

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
  event: string,
  data: unknown,
): Promise<void> {
  const hooks = await prisma.webhook.findMany({
    where: { workspaceId, isActive: true },
  });
  const matching = hooks.filter((hook) =>
    hook.events.split(",").map((name) => name.trim()).includes(event),
  );
  if (matching.length === 0) return;

  const payload = { event, timestamp: new Date().toISOString(), data };
  await Promise.allSettled(matching.map((hook) => deliver(hook.id, hook.url, hook.secret, payload)));
}

async function deliver(
  hookId: string,
  rawUrl: string,
  secret: string,
  payload: { event: string; timestamp: string; data: unknown },
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
        "X-Leadworks-Event": payload.event,
        "User-Agent": "Leadworks-Webhook/1.0",
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`webhook ${hookId} -> ${payload.event}: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`webhook ${hookId} -> ${payload.event} failed:`, error);
  }
}
