import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { eventNames, NO_FIELD_TO_UPDATE, readJson, validateBody } from "@/lib/validate";
import { unknownEventsProblem } from "@/lib/webhooks";
import { classifyTarget } from "@/lib/egress";
import { WEBHOOK_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * These three handlers used to be bare: no key check, no workspace check, an
 * id taken straight from the URL into Prisma. Any anonymous caller could read
 * a tenant's webhook — GET returns the row, and the row holds the signing
 * secret — or repoint its url at their own server, or delete it. Ownership is
 * asserted after the load and answers 404 for someone else's id, so a probe
 * cannot tell "does not exist" from "not yours".
 */
async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const webhook = await prisma.webhook.findUnique({ where: { id } });
  if (!webhook) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, webhook.workspaceId);
  return NextResponse.json(webhook);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;

  const _owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const input = validateBody(body, WEBHOOK_PATCH);
  if (!input.ok) return input.error;

  // `events` is checked outside the table because the two shapes are not the
  // same: an array or a comma string both arrive, one comma string is stored.
  const events = body.events === undefined ? undefined : eventNames(body.events);
  if (events && !events.ok) return events.error;
  // Same rule as POST: a name this product never emits is refused, not stored.
  if (events?.ok) {
    const unknown = unknownEventsProblem(events.values);
    if (unknown) return NextResponse.json({ error: unknown }, { status: 400 });
  }

  // Same refusal as POST when the patch repoints the subscription.
  if (input.data.url !== undefined) {
    const target = await classifyTarget(input.data.url, "url");
    if (!target.ok) return NextResponse.json({ error: target.reason }, { status: 400 });
  }

  const data = { ...input.data, ...(events?.values ? { events: events.values.join(",") } : {}) };
  // Not `requireWrite`: a body holding only `events` is a write, and the table
  // cannot see it.
  if (!Object.keys(data).length) return NextResponse.json({ error: NO_FIELD_TO_UPDATE }, { status: 400 });

  const webhook = await prisma.webhook.update({ where: { id }, data });
  return NextResponse.json(webhook);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.webhook.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
