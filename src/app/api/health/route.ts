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

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      db: "up",
      queues: await queueDepth(),
      time: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ ok: false, db: "down", time: new Date().toISOString() }, { status: 503 });
  }
}
