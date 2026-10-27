import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody, eventNames } from "@/lib/validate";
import { unknownEventsProblem } from "@/lib/webhooks";
import { classifyTarget } from "@/lib/egress";
import { WEBHOOK_CREATE, webhookReadSelect } from "@/lib/fields";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * This read used to take workspaceId from the query string with no key at all,
 * so an anonymous caller could list any tenant's webhook endpoints and the
 * signing secret stored beside them. The id now comes from the key; a caller who
 * still passes ?workspaceId= gets the documented answer for asking about a
 * workspace that is not theirs (403 from authedWorkspaceId), and the README's
 * `GET /api/webhooks?workspaceId=` contract is otherwise unchanged.
 *
 * The key is what the last fix bought; this one narrows what the key can spend.
 * Measured on the running app before the change, one press of this door printed
 * every subscription's plaintext signing secret — 1,734 bytes for six rows — and
 * so did `GET /api/webhooks/{id}` and the reply to an unrelated `PATCH
 * {isActive:false}`. That credential is not a fact about the subscription the way
 * its url is: it is the key a subscriber verifies deliveries with, and the product's
 * own rule for a plaintext credential is apikeys.ts's "returned once and never
 * persisted". `secret` is therefore read at the door that mints it and nowhere else;
 * every other column of the row is still printed, by name, in `WEBHOOK_READ_COLUMNS`.
 */
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const webhooks = await prisma.webhook.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: webhookReadSelect(),
  });
  return NextResponse.json({ webhooks });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, WEBHOOK_CREATE);
  if (!input.ok) return input.error;
  // The schema comment shows an array of event names; the column is a String and
  // the only reader splits it on commas. Both shapes are accepted, one is
  // stored — measured, `events: ["a.b", "c.d"]` was a 500 and `events: 42` was a
  // 500 on `.length`.
  const events = eventNames(body.events);
  if (!events.ok) return events.error;

  // A name this product never emits is a subscription that never fires — the
  // same silence as no subscription at all, arrived at from the other side.
  // The typo is refused here instead of stored.
  const unknown = unknownEventsProblem(events.values);
  if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });

  // The destination is refused here when it names an internal address — the
  // same rule `assertAllowedTarget` enforces immediately above the delivery
  // fetch — so a subscription that could never deliver is not stored. The
  // documented local override (`ABET_ALLOW_PRIVATE_TARGETS=1`) still applies.
  const target = await classifyTarget(input.data.url, "url");
  if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 400 });

  const secret = crypto.randomBytes(32).toString("hex");
  const webhook = await prisma.webhook.create({
    data: { workspaceId, url: input.data.url, events: events.values.join(","), secret },
  });
  // The one door that prints a signing secret, because it is the one moment the
  // caller has never held it. The reads answer without the column, so a secret lost
  // here is replaced by DELETE + POST — a new row, a new id, a new secret — not
  // re-read.
  return NextResponse.json(webhook, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
