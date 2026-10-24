import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { asStrings, missingIds, unknownIdsError } from "@/lib/ids";
import { pageParams } from "@/lib/pagination";
import { memberPage } from "@/lib/list-page";
import { readJson, validateBody } from "@/lib/validate";
import { LEAD_LIST_PATCH } from "@/lib/fields";
import { listRefreshAsk, planListRefresh, readListFilter } from "@/lib/dynamic-list";
import { describeConditions, leadWhere } from "@/lib/rule-conditions";
import { asInputJson } from "@/lib/json";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  // 100 is the number this door has always handed back; it is now the page size, not the ceiling
  // on the answer, and `pageParams` clamps what a caller may ask for.
  const { page, limit } = pageParams(searchParams, 100);
  const [list, recorded] = await Promise.all([
    prisma.leadList.findUnique({
      where: { id },
      include: {
        members: { include: { lead: true }, orderBy: { leadId: "asc" }, skip: (page - 1) * limit, take: limit },
      },
    }),
    prisma.leadListMember.count({ where: { listId: id } }),
  ]);
  if (!list) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, list.workspaceId);
  return NextResponse.json({ ...list, memberPage: memberPage(recorded, list.members.length, page, limit) });
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.error;

  const _owned = await prisma.leadList.findUnique({
    where: { id },
    select: { workspaceId: true, isDynamic: true, filterJson: true },
  });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const input = validateBody(parsed.body, LEAD_LIST_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;

  // The edit door owes the same refusal as the create door, and one it does not: a filter is
  // checked as it arrives, and a list that would end up dynamic — either because this request
  // says so or because it already was — has to end up holding a filter that can be re-run.
  // `{ isDynamic: true }` onto a list with no `filterJson` used to be a 200 and a dead row.
  const declared = "filterJson" in input.data ? readListFilter(input.data.filterJson) : null;
  if (declared?.problem) return NextResponse.json({ error: declared.problem }, { status: 400 });
  const willBeDynamic = "isDynamic" in input.data ? input.data.isDynamic === true : _owned.isDynamic;
  if (willBeDynamic) {
    const effective = declared ?? readListFilter(_owned.filterJson);
    if (effective.problem) return NextResponse.json({ error: effective.problem }, { status: 400 });
  }

  const list = await prisma.leadList.update({
    where: { id },
    data: declared === null ? input.data : { ...input.data, filterJson: asInputJson(declared.filter) },
  });
  return NextResponse.json(list);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;

  // The refresh branch asks this row what it is, so this read takes the two columns along with
  // the workspace the ownership check needs.
  const _owned = await prisma.leadList.findUnique({
    where: { id },
    select: { workspaceId: true, isDynamic: true, filterJson: true },
  });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  if (action === "add-leads") {
    const { leadIds } = body;
    const parsed = asStrings(leadIds, "leadIds");
    if (parsed.error) return parsed.error;
    if (!parsed.values.length) return NextResponse.json({ error: "leadIds required" }, { status: 400 });

    // One read answers both questions the old code half-asked. The count-of-
    // foreign-ids check passed when an id existed nowhere, so a nonexistent
    // leadId reached createMany and left as a bare P2003 (500); the same query
    // here separates "not yours" (403, as before) from "no such lead" (422,
    // naming it).
    const rows = await prisma.lead.findMany({
      where: { id: { in: parsed.values } },
      select: { id: true, workspaceId: true },
    });
    if (rows.some((r) => r.workspaceId !== _owned.workspaceId)) {
      return NextResponse.json({ error: "leadIds must belong to this workspace" }, { status: 403 });
    }
    const missing = missingIds(parsed.values, rows);
    if (missing.length) return unknownIdsError("leadIds", missing);

    await prisma.leadListMember.createMany({
      data: parsed.values.map((leadId: string) => ({ listId: id, leadId })),
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "remove-leads") {
    const { leadIds } = body;
    const parsed = asStrings(leadIds, "leadIds");
    if (parsed.error) return parsed.error;
    if (!parsed.values.length) return NextResponse.json({ error: "leadIds required" }, { status: 400 });

    // Deleting ids that are not in the list is a no-op, not an error: the
    // caller's goal (these leads out of this list) is true either way.
    await prisma.leadListMember.deleteMany({ where: { listId: id, leadId: { in: parsed.values } } });
    return NextResponse.json({ ok: true });
  }

  if (action === "refresh") {
    // The flag is read from the row. `body.isDynamic` used to decide this branch, so a dynamic
    // list refreshed without typing the flag got `400 "Unknown action"` and a static one got the
    // `ok` as soon as a caller typed it at a row that has no filter to re-run.
    const stored = readListFilter(_owned.filterJson);
    const ask = listRefreshAsk(_owned.isDynamic, stored.problem);
    if (!ask.ok) return NextResponse.json({ error: ask.error }, { status: ask.http });

    const [members, matched] = await Promise.all([
      prisma.leadListMember.findMany({ where: { listId: id }, select: { leadId: true } }),
      prisma.lead.findMany({ where: leadWhere(_owned.workspaceId, stored.filter), select: { id: true } }),
    ]);
    const plan = planListRefresh(members.map((m) => m.leadId), matched.map((m) => m.id));

    // The membership set is the indivisible unit here, so the two writes go as one transaction,
    // removal first: a reader between them would otherwise see a list that has lost its old
    // crowd and not yet gained the new one, and a refresh of a filter nobody left is a no-op.
    const writes = [];
    if (plan.remove.length > 0) {
      writes.push(prisma.leadListMember.deleteMany({ where: { listId: id, leadId: { in: plan.remove } } }));
    }
    if (plan.add.length > 0) {
      writes.push(prisma.leadListMember.createMany({ data: plan.add.map((leadId) => ({ listId: id, leadId })) }));
    }
    if (writes.length > 0) await prisma.$transaction(writes);

    return NextResponse.json({
      ok: true,
      filter: describeConditions(stored.filter),
      matched: plan.matched,
      added: plan.add.length,
      removed: plan.remove.length,
      kept: plan.keep.length,
      members: plan.matched,
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.leadList.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.leadList.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);