import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { intParam, pageParams } from "@/lib/pagination";
import { asStrings, idFilterParam, missingIds, unknownIdsError } from "@/lib/ids";
import { validateBody, readJson } from "@/lib/validate";
import { LEAD_CREATE, LEAD_FIELD_PICK, type LeadExportField } from "@/lib/fields";
import { fieldsParam, leadSelect } from "@/lib/list-fields";
import { filterParam } from "@/lib/list-filter";
import { LEAD_STATUSES } from "@/lib/enums";
import { scoredWriteData } from "@/lib/lead-score";
import { emailCaseConflict, emailCaseHolder } from "@/lib/lead-email";
import { dispatchWebhookEvent } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  // The same door already refuses `?fields=nonsense` by name and accepts
  // `?status=nonsense` as a filter that matches nothing. `status` is the column
  // `PATCH /api/leads/{id}` validates against `LEAD_STATUSES`, so the filter is
  // judged by that table now too — see `lib/list-filter.ts`.
  const status = filterParam(searchParams, "status", LEAD_STATUSES);
  if (status.error) return status.error;
  const minScore = intParam(searchParams, "minScore", 0, 0, 100);
  const maxScore = intParam(searchParams, "maxScore", 100, 0, 100);
  const { page, limit } = pageParams(searchParams, 50);

  // The list to filter by is resolved before it filters: `POST /api/leads` already
  // refuses an unknown `listIds` entry with a 422 naming it, and this door answered the
  // same typo with `200 total=0` — the shape of "this list is empty".
  const list = await idFilterParam(searchParams, "listId", (id) =>
    prisma.leadList.count({ where: { workspaceId, id } }).then((n) => n > 0));
  if (list.error) return list.error;

  const where: any = { workspaceId };
  if (list.id) where.listMemberships = { some: { listId: list.id } };
  if (status.value) where.status = status.value;
  if (minScore > 0) where.score = { ...where.score, gte: minScore };
  if (maxScore < 100) where.score = { ...where.score, lte: maxScore };

  // Same parameter, same vocabulary, same refusal as `GET /api/lead-lists/{id}`:
  // a projected page carries the named columns and nothing else, so the nested
  // membership objects and their counts are not handed to a caller who named none.
  const asked = fieldsParam(searchParams);
  let picked: LeadExportField[] | undefined;
  if (asked !== null) {
    const input = validateBody({ fields: asked }, LEAD_FIELD_PICK);
    if (!input.ok) return input.error;
    picked = input.data.fields as LeadExportField[];
  }

  const pageWindow = { where, orderBy: { score: "desc" as const }, skip: (page - 1) * limit, take: limit };

  const [leads, total] = await Promise.all([
    picked
      ? prisma.lead.findMany({ ...pageWindow, select: leadSelect(picked) })
      : prisma.lead.findMany({
          ...pageWindow,
          include: { listMemberships: { include: { list: true } }, _count: { select: { activities: true, enrichmentLogs: true } } },
        }),
    prisma.lead.count({ where }),
  ]);

  const envelope = { leads, total, page, limit, totalPages: Math.ceil(total / limit) };
  return NextResponse.json(picked ? { ...envelope, leadFields: picked } : envelope);
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, LEAD_CREATE);
  if (!input.ok) return input.error;

  if (!input.data.email && !input.data.phone && !input.data.linkedinUrl) {
    return NextResponse.json({ error: "at least one contact method required" }, { status: 400 });
  }

  // One address, one row. `@@unique([workspaceId, email])` compares bytes, so the second
  // spelling of an address this workspace already holds walked past it and became a second
  // person: measured on the base build, `john@x.com`, `JOHN@X.COM` and `John@X.com` were three
  // 201s and `GET /api/leads?limit=100` listed all three. The file door refuses the same row
  // (`duplicatesExisting: 1`, `imported: 0`) because it folds case before it looks, and the
  // DEDUPE job then spends a merge folding away what this door accepted (`found=2 resolved=2`).
  // So this was the last place left where a person could be written twice.
  //
  // Refused, not rewritten: the bytes of a row that already exists are nobody's business here,
  // and a new address is still stored exactly as it was sent. A collision with the same bytes is
  // left to the index, which answers that one itself.
  const askedEmail = input.data.email;
  if (typeof askedEmail === "string") {
    const holders = await prisma.lead.findMany({
      where: { workspaceId, email: { equals: askedEmail, mode: "insensitive" } },
      select: { id: true, email: true },
      // The oldest holder gets named: three spellings of one address leave the
      // database free to return them in any order, and a refusal that names a row
      // should name the same one every time the same press is made.
      orderBy: { createdAt: "asc" },
    });
    const holder = emailCaseHolder(askedEmail, holders);
    if (holder) return emailCaseConflict(holder, askedEmail);
  }

  // Every list the caller names has to exist here, or the lead is created
  // outside all of them and silently misses every campaign keyed to those
  // lists. That is the same silent-miss failure the nested write below exists
  // to prevent, so it is checked at the boundary rather than left to a P2003.
  const lists = asStrings(body.listIds, "listIds");
  if (lists.error) return lists.error;
  if (lists.values.length) {
    const found = await prisma.leadList.findMany({ where: { workspaceId, id: { in: lists.values } }, select: { id: true } });
    const missing = missingIds(lists.values, found);
    if (missing.length) return unknownIdsError("listIds", missing);
  }

  // The list memberships commit with the lead or not at all: a 201 that left
  // the lead outside every list the caller named is a record that silently
  // misses every campaign keyed to those lists. One nested write does that; an
  // interactive $transaction also does but is a SQLite write-lock queue that
  // collapses under concurrent writers (2.5 rps at c=10, mostly P1008 timeouts).
  const lead = await prisma.lead.create({
    data: {
      workspaceId,
      ...input.data,
      // Required Json columns: an absent `tags` is not written by the table
      // above, and the column has no default, so a lead with no tags still needs
      // the array here. `mergeLeads` in `dedupe.ts` spreads all three.
      technologies: input.data.technologies ?? [],
      intentSignals: input.data.intentSignals ?? [],
      tags: input.data.tags ?? [],
      status: "NEW",
      // `LEAD_CREATE` has no `score`, so a created lead used to sit at the column
      // default of 0 while the dashboard and `orderBy: { score: "desc" }` ranked
      // buyers by it. The row's own signals are the only thing a score comes from,
      // and they are all present here, so it is computed before the insert rather
      // than written by a second round trip.
      ...scoredWriteData(input.data),
      ...(lists.values.length
        ? { listMemberships: { create: lists.values.map((listId: string) => ({ listId })) } }
        : {}),
    },
  });

  await dispatchWebhookEvent(workspaceId, "lead.created", { lead });

  return NextResponse.json(lead, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
