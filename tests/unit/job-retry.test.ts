// #42 — the door that stops a job is the door that can start it again.
//
// Measured before this file's subject shipped: last round made `?action=cancel` true. A
// worker between two rows reads the mark, finishes the row it had started, and stamps
// `CANCELLED` with the arithmetic of what it actually did — and the same round's own table
// then claimed, in the row for `?action=retry`, that an operator who stopped a job at row 4
// of 200 "restarts it over the rows still standing". The door answered that sentence with
// `400 "Can only retry failed or completed jobs"`. `CANCELLED` was not in the two words the
// guard accepted, so the stop was honest and irreversible at once: the row told the operator
// exactly how many leads were never reached, and refused to let anything reach them.
//
// So this file pins the two decisions `src/lib/job-retry.ts` now owns — which statuses a
// resume may be taken from, and what the row it creates is allowed to claim about itself —
// and the wiring that makes them the door's behaviour: the status asked before the runner
// and before the insert, the queue told after the insert, the stopped row never written, and
// the second walk made safe by the gate the visit itself obeys, which is what lets a resume
// carry the whole crowd rather than a position inside it.
//
// Nothing here needs a browser, a database or a network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { MARK } from "../../src/lib/job-stop";
import { retryAsk, retryRow } from "../../src/lib/job-retry";
import { JOB_STATUSES } from "../../src/lib/enums";
import { enrichmentVisit, jobResultRow, progressValue } from "../../src/lib/job-report";
import { planEnrichmentWrite } from "../../src/lib/enrich-plan";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });
/** Every `src/` file whose code (not prose) mentions a string, by repo-relative path. */
const mentioners = (needle: string): string[] =>
  srcFiles(srcDir)
    .filter((file) => blankComments(readFileSync(file, "utf8")).includes(needle))
    .map((file) => file.replace(/.*\/src\//, "src/"))
    .sort();

const retrySource = blankComments(at("../../src/lib/job-retry.ts"));
const detailRoute = at("../../src/app/api/jobs/[id]/route.ts");
const guardedRoute = blankComments(detailRoute);
const postBody = functionBody(guardedRoute, "POST_impl") ?? "";

/** The crowd a stopped job was told to walk, in the order its config names it. */
const CROWD = ["lead-1", "lead-2", "lead-3", "lead-4"];

/**
 * A row as the door reads it after a stop mid-run: the mark, a denominator, 3 of 300
 * counted, one percent, and an error field the first row never used. Everything after
 * `status`/`config` is what a resume must not carry over.
 */
const markedRow = {
  id: "job-stopped",
  workspaceId: "ws-1",
  sourceId: null,
  type: "ENRICH",
  status: MARK,
  config: { providers: ["derive"], fields: ["seniority"], leadIds: CROWD },
  progress: 1,
  totalItems: 300,
  processedItems: 3,
  failedItems: 0,
  error: null,
  startedAt: new Date("2026-10-22T09:00:00.000Z"),
  completedAt: new Date("2026-10-22T09:00:04.000Z"),
  createdAt: new Date("2026-10-22T08:59:00.000Z"),
  updatedAt: new Date("2026-10-22T09:00:04.000Z"),
};

/** The provider's answer. Deterministic in this build, so both walks give the same one. */
const ANSWER = { seniority: "DIRECTOR" };

/** One visit, as the worker makes it: the plan for the row, and the record of the visit. */
function visit(lead: Record<string, unknown>) {
  const plan = planEnrichmentWrite(lead as { status: string } & Record<string, unknown>, ANSWER);
  const record = jobResultRow("resumed-job", enrichmentVisit(String(lead.id), {
    lead,
    named: Object.keys(ANSWER),
    answered: Object.keys(ANSWER),
    written: plan.written,
    declaredFields: ["seniority"],
  }));
  return { plan, record, detail: record.data as Record<string, unknown> };
}

describe("which rows a resume may be taken from", () => {
  it("takes one from the mark — the whole of what changed", () => {
    assert.deepEqual(retryAsk(MARK), { ok: true });
    assert.equal(retryAsk("CANCELLED").ok, true, "a stopped row is resumable, which last round's door refused");
  });

  it("still takes one from the two words it always took", () => {
    assert.deepEqual(retryAsk("COMPLETED"), { ok: true });
    assert.deepEqual(retryAsk("FAILED"), { ok: true });
  });

  it("refuses a row a worker still holds, and says what the resume would have done", () => {
    for (const status of ["PENDING", "RUNNING"]) {
      const ask = retryAsk(status);
      assert.equal(ask.ok, false, `${status} is not a stop — it is a job that has not finished`);
      if (ask.ok) continue;
      assert.equal(ask.http, 409, "the row's state is what refuses, not the request as stated");
      assert.match(ask.error, /walk this crowd twice/, "the reason is a second runner over the same leads");
    }
  });

  it("tells a queued row from a running one, because they are two different waits", () => {
    const queued = retryAsk("PENDING");
    const running = retryAsk("RUNNING");
    assert.ok(!queued.ok && !running.ok);
    assert.match(queued.error, /has not reached it/, "a PENDING row will run on its own");
    assert.match(running.error, /between rows/, "a RUNNING row has a worker holding it right now");
  });

  it("refuses a word the schema does not document, and names it", () => {
    const ask = retryAsk("DONE");
    assert.equal(ask.ok, false);
    if (ask.ok) return;
    assert.equal(ask.http, 400, "a status outside the set is a row no guard can vouch for");
    assert.match(ask.error, /"DONE"/, "the answer carries the word it could not read");
  });

  it("does not read a lookalike as the mark it resembles", () => {
    // `lib/fields.ts` records that a status outside the set is invisible to every
    // comparison in the application. A guard that fell through would open for anything
    // it does not know, which is the same failure seen from the other side.
    for (const word of ["cancelled", "Canceled", "COMPLETED ", "", "   ", "null"]) {
      assert.equal(retryAsk(word).ok, false, `${JSON.stringify(word)} is not a terminal status`);
    }
  });

  it("answers all five documented words, and only the three a worker has put down", () => {
    assert.deepEqual(JOB_STATUSES.filter((status) => retryAsk(status).ok), ["COMPLETED", "FAILED", "CANCELLED"]);
    assert.deepEqual(JOB_STATUSES.filter((status) => !retryAsk(status).ok), ["PENDING", "RUNNING"]);
  });

  it("spells the mark once, by the name job-stop owns", () => {
    assert.match(retrySource, /import \{ MARK \} from "\.\/job-stop"/);
    assert.ok(!retrySource.includes('"CANCELLED"'), "no second copy of the word that decides this");
    assert.ok(!retrySource.includes('"PENDING" && '), "and no second copy of the words it refuses");
  });
});

describe("what the resumed row is allowed to claim about itself", () => {
  const payload = retryRow(markedRow);

  it("carries the crowd, the type and the workspace, and says PENDING", () => {
    assert.equal(payload.workspaceId, "ws-1");
    assert.equal(payload.type, "ENRICH");
    assert.equal(payload.status, "PENDING", "the queue has not been told yet, so the row says so");
    assert.deepEqual(payload.config, { providers: ["derive"], fields: ["seniority"], leadIds: CROWD });
  });

  it("carries the whole crowd, not the part still standing — there is no cursor", () => {
    assert.deepEqual((payload.config as { leadIds: string[] }).leadIds, CROWD);
    assert.equal((payload.config as { leadIds: string[] }).leadIds.length, 4);
    assert.ok(!("offset" in payload) && !("resumeAt" in payload), "nothing on this table remembers a position");
  });

  it("carries none of the first row's account of its own work", () => {
    assert.deepEqual(Object.keys(payload).sort(), ["config", "status", "type", "workspaceId"]);
    for (const column of ["id", "progress", "totalItems", "processedItems", "failedItems", "error", "startedAt", "completedAt", "createdAt", "updatedAt"]) {
      assert.ok(!(column in payload), `${column} would be a job claiming work it never did`);
    }
  });

  it("opens at nothing, while the row it came from still reports 1 of 300", () => {
    const stopped = progressValue({ total: markedRow.totalItems, processed: markedRow.processedItems, failed: markedRow.failedItems });
    assert.equal(stopped, 1, "the mark's own row says 1 percent, which is what 3 of 300 is");
    assert.equal(progressValue({ total: 0, processed: 0, failed: 0 }), 0, "a row that has walked nothing says 0");
    assert.ok(!("processedItems" in payload) && !("totalItems" in payload), "so the resume carries neither number");
  });

  it("keeps a source when the row has one and omits the key when it has none", () => {
    assert.ok(!("sourceId" in payload), "null is not a foreign key; omitting it is");
    assert.equal(retryRow({ ...markedRow, sourceId: "src-9" }).sourceId, "src-9");
    assert.ok(!("sourceId" in retryRow({ ...markedRow, sourceId: "" })), "an empty string is not a source either");
  });

  it("resumes the same way from any terminal status, mark included", () => {
    for (const status of ["COMPLETED", "FAILED", MARK]) {
      assert.deepEqual(retryRow({ ...markedRow, status }), payload, `${status} is resumable and the row it makes is the same shape`);
    }
  });

  it("holds no query, so the decision has one owner and the route holds the database", () => {
    assert.ok(!retrySource.includes("prisma."), "no read, no write");
    assert.ok(!retrySource.includes("NextResponse"), "and no status code — the door turns the answer into one");
    const callers = (name: string) => mentioners(`${name}(`).filter((f) => !f.includes("job-retry"));
    assert.deepEqual(callers("retryRow"), ["src/app/api/jobs/[id]/route.ts"]);
    assert.deepEqual(callers("retryAsk"), ["src/app/api/jobs/[id]/route.ts"]);
  });
});

describe("the second walk, and the gate that makes it safe", () => {
  it("refuses to re-write a column the row already holds", () => {
    const { plan } = visit({ id: "lead-1", status: "ENRICHED", seniority: "DIRECTOR" });
    assert.deepEqual(plan.written, [], "the value the first walk put there outlives the second");
    assert.ok(!("seniority" in plan.data), "the update does not even re-state it");
  });

  it("writes the row the mark left standing", () => {
    const { plan } = visit({ id: "lead-4", status: "NEW", seniority: null });
    assert.deepEqual(plan.written, ["seniority"]);
    assert.equal(plan.data.seniority, "DIRECTOR");
    assert.equal(plan.data.status, "ENRICHED", "and the status moves the way one visit moves it");
  });

  it("records the refusal with the gate that made it, by name", () => {
    const { record, detail } = visit({ id: "lead-1", status: "ENRICHED", seniority: "DIRECTOR" });
    assert.equal(record.status, "SKIPPED");
    assert.match(String(detail.reason), /the row already held `seniority`/);
    assert.deepEqual(detail.alreadyHeld, ["seniority"]);
  });

  it("ends a resumed crowd exactly where an uninterrupted job would have", () => {
    const leads = [
      { id: "lead-1", status: "ENRICHED", seniority: "DIRECTOR" },
      { id: "lead-2", status: "ENRICHED", seniority: "DIRECTOR" },
      { id: "lead-3", status: "ENRICHED", seniority: "DIRECTOR" },
      { id: "lead-4", status: "NEW", seniority: null },
    ];
    const out = leads.map((lead) => ({ lead, ...visit(lead) }));
    const wrote = out.filter(({ plan }) => plan.written.length > 0);
    const refused = out.filter(({ record }) => record.status === "SKIPPED");
    assert.equal(wrote.length, 1, "one lead still needed its seniority");
    assert.equal(refused.length, 3, "and three say so, per row, on the resumed job");
    for (const { lead, plan, record } of out) {
      const ending = plan.written.length > 0 ? plan.data.seniority : lead.seniority;
      assert.equal(ending, "DIRECTOR", `${lead.id} ends holding the one value, not a second opinion`);
      assert.ok(record.leadId === lead.id, "every row of the crowd is accounted for on the resume");
    }
  });

  it("stamps the visit either way, because the walk really happened", () => {
    // `lastEnrichedAt` is the honest stamp of "the worker looked at this row", so a
    // refused second visit moves it and records PARTIAL rather than pretending to skip.
    const { plan, record } = visit({ id: "lead-1", status: "ENRICHED", seniority: "DIRECTOR" });
    assert.ok(plan.data.lastEnrichedAt instanceof Date);
    assert.equal(plan.logStatus, "PARTIAL");
    assert.equal(record.status, "SKIPPED", "the per-item record still says nothing was filled");
  });

  it("pulls no lead back out of the status the sales process put it in", () => {
    const { plan } = visit({ id: "lead-2", status: "CONTACTED", seniority: null });
    assert.deepEqual(plan.written, ["seniority"], "the gap is still filled");
    assert.ok(!("status" in plan.data), "and a contacted lead is not silently re-tagged as merely enriched");
  });
});

describe("the door's order, and what it refuses to touch", () => {
  it("asks the row's status through the module, and no longer compares words itself", () => {
    assert.match(guardedRoute, /const ask = retryAsk\(job\.status\)/);
    assert.ok(!guardedRoute.includes('job.status !== "FAILED"'), "the guard is not spelled out twice");
    assert.ok(!guardedRoute.includes("Can only retry failed or completed jobs"), "the old answer is gone from this door");
  });

  it("refuses before it inserts, so no row is left behind that nothing will run", () => {
    const askAt = postBody.indexOf("retryAsk(job.status)");
    const runnerAt = postBody.indexOf("hasRunner(job.type)");
    const createAt = postBody.indexOf("prisma.job.create");
    assert.ok(askAt >= 0 && runnerAt > askAt && createAt > runnerAt, "status, then runner, then insert");
    assert.match(postBody, /if \(!ask\.ok\) return NextResponse\.json\(\{ error: ask\.error \}, \{ status: ask\.http \}\)/);
  });

  it("queues the row it made, or answers with the queue's own status", () => {
    const createAt = postBody.indexOf("prisma.job.create");
    const enqueueAt = postBody.indexOf("enqueueJob(job.type, newJob.id)");
    assert.ok(enqueueAt > createAt, "a PENDING row nobody queued reads exactly like one that is queued");
    assert.match(postBody, /QueueUnavailableError/);
  });

  it("creates a row and never writes the stopped one", () => {
    const branch = postBody.slice(postBody.indexOf('if (action === "retry")'), postBody.indexOf('if (action === "cancel")'));
    assert.match(branch, /prisma\.job\.create\(\{ data: retryRow\(job\) \}\)/, "one row read, one row made");
    assert.ok(!/job\.update/.test(branch), "the mark is not walked back to PENDING by the resume it caused");
    assert.ok(!branch.includes("updateMany"), "and no guarded write does it either");
  });

  it("still refuses to cancel a row that has finished, or a marked row twice", () => {
    assert.match(
      postBody,
      /if \(job\.status === "COMPLETED" \|\| job\.status === "FAILED" \|\| job\.status === "CANCELLED"\)/,
      "a stop is taken from a row that is still running; that guard is untouched",
    );
  });

  it("keeps the two refusal codes the two refusals mean", () => {
    assert.match(postBody, /status: ask\.http/, "409 for a row a worker still holds, 400 for a word no guard can read");
    assert.ok(!postBody.includes("status: 500"), "no refusal here is a server fault");
    assert.match(postBody, /\{ status: 409 \}/, "the no-runner answer keeps the code it had");
  });

  it("is the only new hand on the retry path, by census", () => {
    assert.deepEqual(
      mentioners("retry").filter((f) => !f.includes("auth") && !f.includes("throttle") && !f.includes("tokens") && !f.includes("billing") && !f.endsWith("page.tsx")),
      [
        "src/app/api/exports/[id]/route.ts",
        "src/app/api/jobs/[id]/route.ts",
        "src/lib/export-stop.ts",
        "src/lib/job-retry.ts",
        "src/lib/queue.ts",
      ],
      "the two doors that retry, the module that decides this one, the queue that runs it, and #43's sentence telling a stopped export's caller to retry it — `support/page.tsx` spells the word about a ticket, not a job",
    );
  });
});
