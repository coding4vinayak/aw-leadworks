import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { readJson, validateBody } from "@/lib/validate";
import { SOURCE_PATCH } from "@/lib/fields";
import { scheduleProblem } from "@/lib/cron-schedule";
import { NO_TARGET_REASON, scrapeTarget, scrapeTargetProblem } from "@/lib/scrape-capability";
import { readBrowserProbe } from "@/lib/scraper";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { markNeverQueued } from "@/lib/queue-refusal";
import { SOURCE_ACTIONS, actionParam } from "@/lib/action-word";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = await prisma.source.findUnique({
    where: { id },
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 10 }, _count: { select: { jobs: true } } },
  });
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, source.workspaceId);
  return NextResponse.json(source);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = await readJson(request);
  if (!raw.ok) return raw.error;

  const _owned = await prisma.source.findUnique({ where: { id }, select: { workspaceId: true, type: true, config: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  const input = validateBody(raw.body, SOURCE_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  // The edit door refuses what the create door refuses: `null` still means "no cadence",
  // and a cadence the sweep cannot match means the same thing said in a way the operator
  // would have to discover from an empty schedule.
  if (typeof input.data.schedule === "string") {
    const unreadable = scheduleProblem(input.data.schedule);
    if (unreadable !== null) return NextResponse.json({ error: unreadable }, { status: 400 });
  }
  // ...and the same address judgement, because repointing an existing source at
  // `file:///etc/passwd` is the same write as creating one with that config, and #39
  // measured it landing. The pair is judged as it will read once the update has run: a
  // patch that does not name `config` leaves the stored one in place, and a patch that
  // does not name `type` leaves a scraper a scraper.
  const effectiveConfig = input.data.config === undefined ? _owned.config : input.data.config;
  const target = scrapeTarget(effectiveConfig);
  if (target !== null) {
    const refused = await scrapeTargetProblem(effectiveConfig);
    if (refused !== null) return NextResponse.json({ error: refused }, { status: 400 });
  } else if ((input.data.type ?? _owned.type) === "WEB_SCRAPER") {
    // `type` on the row says whether this source is a scraper; `config` says whether it
    // has an address. Either half arriving alone is the moment the pair becomes a promise
    // nobody can keep — `{ type: "WEB_SCRAPER" }` against a row whose config holds no url,
    // or `config: {}` against a row that is already a scraper.
    return NextResponse.json({ error: NO_TARGET_REASON }, { status: 400 });
  }
  const source = await prisma.source.update({ where: { id }, data: input.data });
  return NextResponse.json(source);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const asked = actionParam(searchParams, SOURCE_ACTIONS);
  const action = asked.action;

  if (action === "run") {
    const source = await prisma.source.findUnique({ where: { id }, select: { workspaceId: true, config: true } });
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
    await assertOwns(request, source.workspaceId);

    // The stored row is judged here as well as at the two write doors, because it can
    // predate them: a `file:///etc/passwd` config that was a legal 201 last week is a job
    // this door is about to mint and this instance is about to try to open. Refusing here
    // means the answer is a 400 naming the address, instead of a 200 with a `jobId`, a
    // `PENDING` row, and a `FAILED` one a few seconds later. Policy before capability, for
    // the same reason the worker asks in that order — the verdict that does not depend on
    // which box this is running on must not be able to hide behind the one that does.
    const refused = await scrapeTargetProblem(source.config);
    if (refused !== null) return NextResponse.json({ error: refused }, { status: 400 });
    if (scrapeTarget(source.config) === null) {
      // Every run of a source mints a `SCRAPE` job whatever the `type` column says, and a
      // scrape with no address has nothing to navigate to. #39 measured the row it produced:
      // `jobId`, `PENDING`, then the launch's banner.
      return NextResponse.json({ error: NO_TARGET_REASON }, { status: 400 });
    }
    // A browser-less instance cannot scrape, and saying so after the job exists is how the
    // fact arrived as a five-line box-drawing banner in `Job.error` and `Source.lastRunError`
    // — three sources run in a row on this box, three identical failures, not one sentence
    // about the instance. 503 because nothing about the request is wrong: the same call
    // against a deployment that has run `npx playwright install chromium` succeeds.
    const capability = readBrowserProbe();
    if (!capability.runnable) return NextResponse.json({ error: capability.reason }, { status: 503 });

    const job = await prisma.job.create({
      data: {
        // `|| ""` was noise: workspaceId is a required column, and an empty one
        // would have made this a job belonging to no workspace (a foreign-key
        // violation, i.e. a 500) rather than anything worth falling back to.
        workspaceId: source.workspaceId,
        sourceId: id,
        type: "SCRAPE",
        status: "PENDING",
        config: source.config ?? {},
      },
    });
    try {
      await enqueue(queues.scrape, "run-scrape", { jobId: job.id });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        // The queue refused this row, so the row says so: left at `PENDING` it is a job no
        // worker will run and no door will resume — `retryAsk` answers 409 for it, "it will run".
        await markNeverQueued(job.id);
        return NextResponse.json({ error: error.message, jobId: job.id }, { status: error.status });
      }
      throw error;
    }
    return NextResponse.json({ jobId: job.id });
  }

  // `actionParam` refused this spelling: it named nothing, or it named more than one word,
  // or it named a word this door does not take. The old sentence is kept for a word that is
  // in `SOURCE_ACTIONS` and reached no branch, which the census test prevents.
  return asked.error ?? NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.source.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.source.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
