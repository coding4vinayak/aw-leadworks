import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody, eventNames } from "@/lib/validate";
import { unknownEventsProblem } from "@/lib/webhooks";
import { WEBHOOK_CREATE } from "@/lib/fields";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * This read used to take workspaceId from the query string with no key at all,
 * so an anonymous caller could list any tenant's webhook endpoints and the
 * signing secret stored beside them. The id now comes from the key; a caller who
 * still passes ?workspaceId= gets the documented answer for asking about a
 * workspace that is not theirs (403 from authedWorkspaceId), and the README's
 * `GET /api/webhooks?workspaceId=` contract is otherwise unchanged.
 */
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));

  const webhooks = await prisma.webhook.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
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

  const secret = crypto.randomBytes(32).toString("hex");
  const webhook = await prisma.webhook.create({
    data: { workspaceId, url: input.data.url, events: events.values.join(","), secret },
  });
  return NextResponse.json(webhook, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
