import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queues } from "@/lib/queue";

export const dynamic = "force-dynamic";

/** Queue depth snapshot. Best-effort: Redis down reports, it never 503s. */
async function queueDepth(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    for (const [name, queue] of Object.entries(queues)) {
      const c = await queue.getJobCounts("waiting", "active", "failed");
      out[name] = { waiting: c.waiting, active: c.active, failed: c.failed };
    }
  } catch {
    return { error: "redis unreachable" };
  }
  return out;
}

/**
 * Whether this instance can run a scrape, in the same best-effort shape as the queue depth.
 *
 * It is a fact about the deployment, not a health check: a box with no browser is a healthy
 * box that cannot scrape, so this rides alongside `db` and `queues` without touching `ok`.
 * The probe is imported lazily and wrapped because `readBrowserProbe` is the one call here
 * that reaches into a third-party library's view of the filesystem — if that import or the
 * resolver inside it throws, the answer an operator wants is "unknown", not a health door
 * that has stopped answering. #39 measured a scrape failure arriving as a five-line
 * box-drawing banner in `Job.error` and nothing anywhere saying the instance lacked the
 * browser; this field is the sentence said before the job instead of after it.
 */
async function scrapeStatus(): Promise<Record<string, unknown>> {
  try {
    const { readBrowserProbe } = await import("@/lib/scraper");
    const capability = readBrowserProbe();
    return capability.runnable
      ? { runnable: true, browser: capability.executablePath }
      : { runnable: false, reason: capability.reason };
  } catch (error) {
    return { runnable: false, reason: `the browser probe could not be asked: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      db: "up",
      queues: await queueDepth(),
      scrape: await scrapeStatus(),
      time: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ ok: false, db: "down", time: new Date().toISOString() }, { status: 503 });
  }
}
