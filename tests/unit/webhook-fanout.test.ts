// #53 — a fan-out is not a queue: the attempts a batch owes are independent, and the
// door pays for them in waves rather than one after another.
//
// Measured against a running instance of this app before any of this shipped, on this
// round's own base (`origin/main` at `65bd942`, built in this worktree, served on :3331
// over the session's own database `leadworks_r53`, booted with the documented
// `ABET_ALLOW_PRIVATE_TARGETS=1` so a subscription may name a receiver on this box),
// in `/tmp/opencode/r53_measure.log`. Every number below is `curl`'s own `%time_total`
// for the door call, so it is the caller's time and not a log line:
//
//   no subscription        1 row 0.043 s     20 rows 0.166 s
//   receiver answers 200   1 row 0.072 s     20 rows 0.226 s
//   receiver answers after 300 ms — 1 row 0.317 s     20 rows 6.222 s
//   receiver never answers — 1 row 5.037 s, 5 rows 25.070 s, 20 rows 100.190 s,
//                            40 rows 200.275 s
//
// The last four are the defect: the import awaited one delivery per row, so the door's
// answer time was the row count times one third party's latency, and the 5 s attempt
// budget that #17 named as the reason "a hung receiver cannot pin the caller" bounds a
// single attempt and nothing else. 20 × 5.009 = 100.19 and 40 × 5.006 = 200.27: the
// crowd multiplies the budget. The receiver's own count for those runs was 72 hits on
// the silent path and 6 on the second subscription, which is the row counts summed —
// no attempt was lost or made twice, so the fix cannot be to make fewer attempts.
//
// The same log holds the second half. A subscription that answered **500** cost the
// door 0.018 s and changed nothing it said: `POST /api/leads` returned the row with
// `201` exactly as it does for a subscriber that says yes, and the 500 was written
// down in one place — this instance's own stdout, the line
// `webhook cmvo1su82… -> lead.created: 500 Internal Server Error`. `GET
// /api/webhooks/{id}` afterwards prints the row: its url, its events, `isActive: true`
// and the signing secret, and nothing about a delivery, because nothing records one.
//
// So the fix is arithmetic, not I/O: `fanOut` says how many attempts may be in flight,
// `tallyDeliveries` says what the fan-out did and which kind of no each failure was,
// and the import spends both once. Everything below runs offline — no browser, no
// database, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import {
  WEBHOOK_ATTEMPT_BUDGET_MS,
  WEBHOOK_FANOUT,
  classifyDeliveryFailure,
  emptyTally,
  fanOut,
  tallyDeliveries,
  wavesFor,
} from "../../src/lib/webhook-fanout";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const fanout = blankComments(at("../../src/lib/webhook-fanout.ts"));
const sender = blankComments(at("../../src/lib/webhooks.ts"));
const importer = blankComments(at("../../src/lib/csv-import.ts"));

describe("the pool spreads attempts and never loses one", () => {
  it("runs every item exactly once", async () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const ran: number[] = [];
    await fanOut(items, 8, async (item) => {
      ran.push(item);
    });
    assert.deepEqual(ran.sort((a, b) => a - b), items, "twenty items in, twenty attempts out, none twice");
  });

  it("never has more than the width in flight", async () => {
    let live = 0;
    let peak = 0;
    await fanOut(Array.from({ length: 20 }, (_, i) => i), WEBHOOK_FANOUT, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setImmediate(resolve));
      live--;
    });
    assert.equal(peak, WEBHOOK_FANOUT, "the width is what the receiver sees, not a suggestion");
  });

  it("spreads a whole batch when the batch fits in one wave", async () => {
    // The other half of the same rule: 20 rows against a receiver that never
    // answered was three waves, not one, and a 5-row import is one wave — the door
    // pays the budget once.
    let live = 0;
    let peak = 0;
    await fanOut(Array.from({ length: 5 }, (_, i) => i), WEBHOOK_FANOUT, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live--;
    });
    assert.equal(peak, 5);
  });

  it("holds its slot through a task that throws", async () => {
    // `deliver` is total and no task should reject, which is exactly why the pool
    // must not be the thing that decides the contract: a worker lost on a rejection
    // narrows the fan-out for the rest of the batch, silently, under load.
    const ran: number[] = [];
    await fanOut(Array.from({ length: 20 }, (_, i) => i), 4, async (item) => {
      ran.push(item);
      if (item === 3) throw new Error("a task that should not have been able to throw");
    });
    assert.equal(ran.length, 20, "a throwing task costs the batch nothing but itself");
  });

  it("starts no work at all for an empty list", async () => {
    let runs = 0;
    await fanOut([], 8, async () => {
      runs++;
    });
    assert.equal(runs, 0);
  });

  it("refuses a width that is not a width", async () => {
    for (const width of [0, -3, Number.NaN]) {
      const ran: number[] = [];
      await fanOut([1, 2, 3], width, async (item) => {
        ran.push(item);
      });
      assert.deepEqual(ran, [1, 2, 3], `width ${String(width)} must still deliver, one at a time`);
    }
  });

  it("claims items in order, so a wave is the front of the batch", async () => {
    const order: number[] = [];
    await fanOut(Array.from({ length: 9 }, (_, i) => i), 3, async (item) => {
      order.push(item);
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(order.slice(0, 3), [0, 1, 2], "the first wave is the first three rows");
    assert.deepEqual(order.length, 9);
  });

  it("computes the waves the README quotes from the same width", () => {
    assert.equal(wavesFor(0), 0);
    assert.equal(wavesFor(5), 1);
    assert.equal(wavesFor(8), 1);
    assert.equal(wavesFor(20), 3, "the measured 20 rows against a silent receiver");
    assert.equal(wavesFor(240), 30);
  });
});

describe("the tally counts attempts, not intentions", () => {
  const refused = (reason: string) => ({ ok: false, kind: "refused", reason }) as const;
  const silent = (reason: string) => ({ ok: false, kind: "no-answer", reason }) as const;
  const blocked = (reason: string) => ({ ok: false, kind: "blocked", reason }) as const;

  it("partitions the three kinds of no and adds up", () => {
    const tally = tallyDeliveries(2, [{ ok: true }, refused("500 Internal Server Error"), silent("no answer within 5000 ms"), blocked("url must not be an internal address"), { ok: true }]);
    assert.deepEqual(tally, {
      subscriptions: 2,
      attempted: 5,
      delivered: 2,
      refused: 1,
      noAnswer: 1,
      blocked: 1,
      lastError: "url must not be an internal address",
    });
    assert.equal(tally.delivered + tally.refused + tally.noAnswer + tally.blocked, tally.attempted);
  });

  it("keeps a receiver's no apart from its silence", () => {
    // Charged to different parties: 500 is the subscriber's application answering
    // and refusing, 5 s of nothing is a socket. A single "failed" count would make
    // the first — the common one, and the one the operator can fix — read like an
    // outage they cannot.
    const outage = tallyDeliveries(1, [silent("no answer within 5000 ms"), silent("no answer within 5000 ms")]);
    const bug = tallyDeliveries(1, [refused("500 Internal Server Error"), refused("500 Internal Server Error")]);
    assert.equal(outage.attempted, bug.attempted);
    assert.equal(outage.refused, 0);
    assert.equal(bug.noAnswer, 0);
    assert.equal(bug.lastError, "500 Internal Server Error");
  });

  it("reports the last failure in completion order", () => {
    const tally = tallyDeliveries(1, [refused("500 Bad Gateway"), refused("503 Service Unavailable"), refused("500 Internal Server Error")]);
    assert.equal(tally.lastError, "500 Internal Server Error", "a batch against a sick receiver repeats one reason; the operator wants the newest");
  });

  it("says nothing failed when nothing failed", () => {
    assert.equal(tallyDeliveries(3, [{ ok: true }, { ok: true }]).lastError, null);
  });

  it("counts subscriptions apart from the attempts they are owed", () => {
    // 240 rows across 3 subscriptions is 720 attempts and 3 subscriptions. The
    // caller needs both numbers: one says who is watching, the other says how much
    // work the fan-out did.
    const outcomes = Array.from({ length: 720 }, () => ({ ok: true }) as const);
    const tally = tallyDeliveries(3, outcomes);
    assert.equal(tally.subscriptions, 3);
    assert.equal(tally.attempted, 720);
    assert.equal(tally.delivered, 720);
  });

  it("does not claim an attempt nobody made", () => {
    const tally = tallyDeliveries(1, []);
    assert.deepEqual(tally, { ...emptyTally(), subscriptions: 1 });
    assert.equal(tally.attempted, 0);
    assert.equal(tally.delivered, 0);
  });

  it("holds an empty fan-out open with every key at zero", () => {
    // The import returns this shape when the file created no rows, so the key is
    // never absent and never means three things.
    assert.deepEqual(Object.keys(emptyTally()), [
      "subscriptions",
      "attempted",
      "delivered",
      "refused",
      "noAnswer",
      "blocked",
      "lastError",
    ]);
    assert.equal(emptyTally().lastError, null);
  });
});

describe("a failure names the party that owed it", () => {
  it("recognises its own egress refusal before charging the receiver", () => {
    const error = Object.assign(new Error("url must not be an internal address (127.0.0.1). Set ABET_ALLOW_PRIVATE_TARGETS=1 in a development checkout to allow it."), {
      egressCode: "internal",
    });
    const outcome = classifyDeliveryFailure(error);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, "blocked");
    assert.match(outcome.reason, /must not be an internal address/);
  });

  it("names the budget that fired rather than quoting the rejection", () => {
    // Measured on this runtime: `AbortSignal.timeout` rejects with
    // `TimeoutError: The operation was aborted due to timeout` — a budget ran out
    // and the sentence does not say which.
    const error = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const outcome = classifyDeliveryFailure(error);
    assert.equal(outcome.kind, "no-answer");
    assert.equal(outcome.reason, `no answer within ${WEBHOOK_ATTEMPT_BUDGET_MS} ms`);
  });

  it("reads the socket out of the cause, not the wrapper", () => {
    // Measured on this runtime: a refused connection arrives as
    // `TypeError: fetch failed` with `cause: { message: "connect ECONNREFUSED
    // 127.0.0.1:8123", code: "ECONNREFUSED" }`. The wrapper says nothing an
    // operator could act on.
    const outcome = classifyDeliveryFailure(
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8123"), { code: "ECONNREFUSED" }) }),
    );
    assert.equal(outcome.kind, "no-answer");
    assert.equal(outcome.reason, "connect ECONNREFUSED 127.0.0.1:8123");
  });

  it("falls back to the code when the cause has no sentence, and to its own words when it has none", () => {
    assert.equal(classifyDeliveryFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })).reason, "ENOTFOUND");
    assert.equal(classifyDeliveryFailure(new Error("")).reason, "the delivery never completed");
    assert.equal(classifyDeliveryFailure(undefined).reason, "the delivery never completed");
  });

  it("never returns a success", () => {
    for (const error of [new Error("x"), Object.assign(new Error("y"), { egressCode: "dns" }), { name: "AbortError" }]) {
      assert.equal(classifyDeliveryFailure(error).ok, false);
    }
  });
});

describe("the fan-out is spent per subscription, and the batch is looked up once", () => {
  it("gives each subscription its own pool", () => {
    const body = functionBody(sender, "dispatchWebhookBatch")!;
    assert.match(body, /matching\.map\(async \(hook\) =>/, "one pool per matching subscription");
    assert.match(body, /await fanOut\(/, "the pool is the module's, not a hand-rolled loop");
    assert.match(body, /WEBHOOK_FANOUT,/);
    assert.ok(!/fanOut\(\s*attempts/.test(body), "no single pool over every (row × subscription) attempt: nine endpoints on one event must not cost two attempt budgets");
  });

  it("builds one payload per row and shares it across that row's subscriptions", () => {
    const body = functionBody(sender, "dispatchWebhookBatch")!;
    assert.match(body, /const payloads = rows\.map\(/, "the crowd is the unit of the payload");
    assert.equal(body.split("`evt_").length - 1, 1, "the event id is minted once per event, not once per delivery");
    assert.match(body, /if \(matching\.length === 0 \|\| rows\.length === 0\) return tallyDeliveries\(matching\.length, \[\]\)/);
  });

  it("keeps one lookup for the whole batch", () => {
    const body = functionBody(sender, "dispatchWebhookBatch")!;
    assert.equal(body.split("prisma.webhook.findMany").length - 1, 1);
    assert.ok(!/prisma\.webhook\.count/.test(body), "the lookup the import guarded with a count is the lookup this call already does");
  });

  it("keeps one delivery path for a single event and one for a batch", () => {
    assert.match(functionBody(sender, "dispatchWebhookEvent")!, /return dispatchWebhookBatch\(workspaceId, event, \[data\]\)/);
    assert.match(sender, /export async function dispatchWebhookEvent/);
  });

  it("keeps the reading out of the module that does the sending", () => {
    assert.ok(!/prisma\.|fetch\(/.test(fanout), "webhook-fanout.ts holds arithmetic and no I/O, which is what makes the width testable at all");
    assert.match(sender, /from "\.\/webhook-fanout"/);
    assert.ok(!/export const WEBHOOK_FANOUT = \d+/.test(sender), "the width is declared once");
  });

  it("still swallows every failure and still logs it", () => {
    // #17's rule, unchanged: a subscriber's outage is not the caller's 500.
    const body = functionBody(sender, "deliver")!;
    assert.match(body, /console\.error\(`webhook \$\{hookId\} -> \$\{payload\.event\}: \$\{response\.status\}/, "a refused delivery is still printed for whoever reads stdout");
    assert.match(body, /return \{ ok: false, kind: "refused"/, "and it is also counted");
    assert.match(body, /catch \(error\) \{\s*console\.error/);
    assert.match(body, /return classifyDeliveryFailure\(error\)/);
    assert.ok(!/throw/.test(body), "a delivery that cannot be made is an outcome, never a rejection");
  });
});

describe("the import pays the crowd once", () => {
  it("makes one batch call for the whole file", () => {
    assert.match(importer, /report\.webhooks = await dispatchWebhookBatch\(workspaceId, "lead\.created", created\)/);
    assert.ok(!/for \(const lead of created\)/.test(importer), "the per-row await is the defect: it multiplied the attempt budget by the crowd");
    assert.ok(!/dispatchWebhookEvent/.test(importer), "the importer spends the batch, not the single-event shape");
  });

  it("says what the fan-out did on every path that returns", () => {
    assert.match(importer, /webhooks: DeliveryTally/);
    assert.match(importer, /webhooks: emptyTally\(\)/);
    assert.equal(importer.split("return {").length - 1, 3, "three returns, and the summary is built once above them");
    const reportLiteral = /const report = \{[\s\S]{0,400}?\};/.exec(importer)![0];
    assert.match(reportLiteral, /webhooks: emptyTally\(\)/, "the zero is in the shared report, so an absent key never means two things");
  });

  it("keeps a broken fan-out from failing a file whose rows are already committed", () => {
    const body = importer.slice(importer.indexOf("if (created.length)"), importer.indexOf("if (created.length)") + 600);
    assert.match(body, /catch \(error\) \{\s*console\.error\("\[import\] webhook dispatch failed:"/);
    assert.match(body.slice(0, 400), /try \{/, "the dispatch is still wrapped: a batch that throws cannot 500 an import of committed rows");
  });

  it("leaves the single-lead door exactly as #17 pinned it", () => {
    const leadsRoute = blankComments(at("../../src/app/api/leads/route.ts"));
    assert.match(leadsRoute, /await dispatchWebhookEvent\(\s*workspaceId,\s*"lead\.created"/);
    assert.match(leadsRoute, /return NextResponse\.json\(lead, \{ status: 201 \}\)/, "the row is still the whole body — `?fields=` has one more name to refuse than this round adds");
  });

  it("leaves the workers' emissions alone", () => {
    const enrichment = blankComments(at("../../src/lib/enrichment.ts"));
    const exporter = blankComments(at("../../src/lib/exporter.ts"));
    assert.match(enrichment, /dispatchWebhookEvent\(\s*job\.workspaceId,\s*"enrichment\.completed"/);
    assert.match(exporter, /dispatchWebhookEvent\(\s*job\.workspaceId,\s*"export\.completed"/);
    assert.ok(!/dispatchWebhookBatch/.test(enrichment) && !/dispatchWebhookBatch/.test(exporter), "one event per job is already one attempt set; the batch is the crowd's shape");
  });
});

describe("the budget and the width are the numbers the sentences quote", () => {
  it("is the pair the README prints", () => {
    assert.equal(WEBHOOK_ATTEMPT_BUDGET_MS, 5000, "the attempt budget #17 shipped with — unchanged here, because this round does not make a delivery shorter, it makes the crowd wait for one");
    assert.equal(WEBHOOK_FANOUT, 8);
  });

  it("turns the measured door times into the arithmetic they should have been", () => {
    // Base, measured: 20 rows × 5.009 s = 100.19 s. This build: three waves.
    assert.equal(wavesFor(20) * WEBHOOK_ATTEMPT_BUDGET_MS, 15000);
    assert.equal(wavesFor(40) * WEBHOOK_ATTEMPT_BUDGET_MS, 25000, "40 rows against a silent receiver: 200.27 s measured on main, five waves now");
    assert.equal(wavesFor(1) * WEBHOOK_ATTEMPT_BUDGET_MS, 5000, "a single POST is unchanged: one row was already one wave");
  });

  it("does not promise fewer attempts than the contract owes", () => {
    // 240 rows to 3 subscriptions is 720 deliveries whatever the width is; the
    // receiver's own count on the base run (72 hits for 66+6 rows) is the proof
    // that serial was not load-shedding.
    assert.equal(240 * 3, tallyDeliveries(3, Array.from({ length: 720 }, () => ({ ok: true } as const))).attempted);
    assert.equal(wavesFor(720), 90);
  });
});
