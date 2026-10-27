import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { boolParam } from "@/lib/bool-word";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { filterParam } from "@/lib/list-filter";
import { SOURCE_RUN_STATUSES, SOURCE_TYPES } from "@/lib/enums";
import { readJson, validateBody } from "@/lib/validate";
import { SOURCE_CREATE } from "@/lib/fields";
import { scheduleProblem } from "@/lib/cron-schedule";
import { NO_TARGET_REASON, scrapeTarget, scrapeTargetProblem } from "@/lib/scrape-capability";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const active = boolParam(searchParams, "isActive");
  if (active.error) return active.error;
  // `type` is the one column this door's own write route refuses a wrong word for by name
  // (`POST /api/sources {type:"api"}` → 400, measured on the base build of this round), and
  // `lastRunStatus` is the verdict the scrape worker stamps. Neither was ever read: eight
  // presses against six sources — `?type=API`, `?type=api`, `?type=nonsense`,
  // `?type=API&type=MANUAL`, `?lastRunStatus=FAILED` against a source whose sweep run had
  // genuinely failed, `=SUCCESS`, `=PARTIAL`, `=nope` — every one of them answered
  // `total=6` with all five types in the page. A filter this door does not have was sold to
  // the caller as a page that happens to be the whole table. See `lib/list-filter.ts`.
  const type = filterParam(searchParams, "type", SOURCE_TYPES);
  if (type.error) return type.error;
  const lastRunStatus = filterParam(searchParams, "lastRunStatus", SOURCE_RUN_STATUSES);
  if (lastRunStatus.error) return lastRunStatus.error;
  const { page, limit } = pageParams(searchParams, 20);


  const where: any = { workspaceId };
  if (active.value !== null) where.isActive = active.value;
  if (type.value) where.type = type.value;
  if (lastRunStatus.value) where.lastRunStatus = lastRunStatus.value;

  const [sources, total] = await Promise.all([
    prisma.source.findMany({
      where,
      include: { _count: { select: { jobs: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.source.count({ where }),
  ]);

  return NextResponse.json({ sources, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;
  const body = raw.body as Record<string, unknown>;
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  // `isActive: isActive ?? true` and the `!config` guard were the whole check
  // before: the type of every field was the database's problem, and Prisma
  // answers a wrong one with a validation error, which is a 500. Absent
  // `isActive` still means true — that is the column's own `@default`.
  const input = validateBody(body, SOURCE_CREATE);
  if (!input.ok) return input.error;

  // A cadence no minute can equal is not a slower schedule — it is no schedule, and this
  // column takes any 64 characters. #38 measured `*/5 * * * *` stored with a 201, minting
  // zero `Job` rows across four sweep minutes that contained two of its fifth-minutes, while
  // `POST /api/enrichment-rules` refused the identical string with a 400. The refusal is the
  // matcher's own grammar, imported rather than re-spelled, so the door and the minute that
  // reads it cannot drift into disagreeing about what a cron means here.
  if (typeof input.data.schedule === "string") {
    const unreadable = scheduleProblem(input.data.schedule);
    if (unreadable !== null) return NextResponse.json({ error: unreadable }, { status: 400 });
  }

  // The other half of the same promise, and the check this door did not have: `config` is
  // free JSON and `config.url` is the address `runScrapeJob` navigates a browser to, so a
  // create that stored `file:///etc/passwd` was a write of "read this file into a lead".
  // #39 measured ten targets offered to this door — `file:`, `data:`, `javascript:`,
  // `about:config`, `http://admin@127.0.0.1:6379/`, the metadata address, `http://localhost:5432/`,
  // a bare `/etc/passwd`, `localhost:6379/dev.db` and a public control — and all ten were
  // accepted with a 201. The judgement is `egress.ts`'s own, imported rather than re-spelled,
  // so a scrape cannot be pointed anywhere a webhook could not be pointed.
  const target = scrapeTarget(input.data.config);
  if (target !== null) {
    const refused = await scrapeTargetProblem(input.data.config);
    if (refused !== null) return NextResponse.json({ error: refused }, { status: 400 });
  } else if (input.data.type === "WEB_SCRAPER") {
    // A scraper with no address is the shape #34 refused at the rule door: a promise the
    // build cannot perform, stored quietly and discovered as an empty lead table.
    return NextResponse.json({ error: NO_TARGET_REASON }, { status: 400 });
  }

  const source = await prisma.source.create({ data: { workspaceId, ...input.data } });

  return NextResponse.json(source, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
