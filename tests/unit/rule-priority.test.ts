// #34 — `EnrichmentRule.priority` is a ranking, and a ranking has to decide something.
//
// Measured against the running app before this round. One lead, three SCHEDULED rules over
// it, every minute, each asking for `seniority`, created in the order priority 10, 90, 50:
//
//   * `GET /api/enrichment-rules` returned them as **50, 90, 10** — `orderBy: { createdAt:
//     "desc" }`, the number the operator set in none of it;
//   * the sweep queued them as **10 at 07:27:00.096, 90 at .115, 50 at .124** — its
//     `findMany` had no `orderBy` at all, so heap order was the rule order;
//   * **the rule that filled the column was `50`, the one queued last**, because the `enrich`
//     worker runs at `concurrency: 5`: three jobs for one lead raced and the first write to
//     land won, enrichment being additive;
//   * two minutes later that one lead had **six log rows** on it, each recording
//     `creditsUsed: 1`, five of the six visits guaranteed refusals.
//
// So an `orderBy` alone would not have made the ranking true. What a ranking can decide is
// who owns a column this minute, and that is what `src/lib/rule-priority.ts` decides: the
// due rules are walked highest-ranked first, each claims the columns its own declaration
// asked for, and a lower-ranked rule is left with what remains — or with nothing, in which
// case it queues no job, logs nothing, and spends nothing.
//
// What this file pins, in the order the code runs:
//
//   1. the column and the range — both rule doors quote the module's own numbers, so the
//      refusal and the walk cannot disagree about what a ranking is;
//   2. `compareByPriority` / `RULE_PRIORITY_ORDER` — the same three keys, a total order, and
//      no mutation of the caller's array;
//   3. `planTick` — who owns which column, in and out of order, per tenant, decided before
//      any provider runs, and how that composes with `restrictToDeclared` from #32;
//   4. the wiring, scanned from the source — every rule list in `src/` ordered, both sweeps
//      walking the one plan, and the door that runs a rule *because someone asked* not
//      ranked at all.
//
// The live proof is `demo/run-demo.sh leadworks` STEP 15; everything here is reachable
// without a database, so none of these tests asks for one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { ENRICH_WRITABLE, planEnrichmentWrite, type EnrichableLead } from "../../src/lib/enrich-plan";
import { restrictToDeclared } from "../../src/lib/rule-actions";
import { validateBody } from "../../src/lib/validate";
import { RULE_CREATE, RULE_PATCH } from "../../src/lib/fields";
import {
  PRIORITY_DEFAULT,
  PRIORITY_MAX,
  PRIORITY_MIN,
  RULE_PRIORITY_ORDER,
  compareByPriority,
  planTick,
  rankRules,
  unclaimedFields,
  type RankedRule,
} from "../../src/lib/rule-priority";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const schema = at("../../prisma/schema.prisma");
const scheduler = at("../../src/lib/scheduler.ts");
const enrichment = at("../../src/lib/enrichment.ts");
const listDoor = at("../../src/app/api/enrichment-rules/route.ts");
const fieldsTable = at("../../src/lib/fields.ts");
const seed = at("../../prisma/seed.ts");

const BASE = Date.UTC(2026, 9, 21, 7, 0, 0, 0);

interface Row extends RankedRule {
  actions: unknown;
}

/**
 * A rule as a sweep sees it. `age` is minutes after 07:00, which is what `createdAt`
 * means to the tie-break; two rules with the same `age` are the case the `id` exists.
 */
function ranked(id: string, priority: number, age: number, actions: unknown = null, workspaceId = "ws-1"): Row {
  return { id, workspaceId, createdAt: new Date(BASE + age * 60_000), priority, actions };
}

/** The plan's visits, as ids and owned columns — the shape every assertion below reads. */
function owned(plan: ReturnType<typeof planTick<Row>>) {
  return plan.visits.map((visit) => [visit.rule.id, visit.fields] as const);
}

/** The one sentence a refused body answers with, for the message inside an assertion. */
async function refusal(result: { ok: boolean; error?: { json(): Promise<unknown> } }): Promise<string> {
  if (!result.error) return "(accepted, so nothing to quote)";
  const payload = (await result.error.json()) as { error: string };
  return payload.error;
}

describe("the column, the range, and the doors that quote it", () => {
  it("is an Int the schema defaults to the module's own floor", () => {
    const line = schema.split("\n").find((row) => /^\s+priority\s+Int/.test(row));
    assert.ok(line, "the column exists");
    assert.match(line!, /@default\(0\)/);
    assert.equal(PRIORITY_DEFAULT, 0, "the default is the unranked value, not a tie with rank 0 rules");
  });

  it("is bounded by numbers stated once, in the module the walk lives in", () => {
    assert.equal(PRIORITY_MIN, 0);
    assert.equal(PRIORITY_MAX, 100);
    // Both tables quote the constants rather than re-spelling them, so a range change moves
    // the refusal and the walk together or not at all.
    for (const table of [RULE_CREATE, RULE_PATCH]) {
      const field = table.priority;
      assert.equal(field.kind, "int");
      assert.equal(field.min, PRIORITY_MIN);
      assert.equal(field.max, PRIORITY_MAX);
    }
    const quoted = blankComments(fieldsTable)
      .split("\n")
      .filter((line) => line.includes("PRIORITY_MIN") && !line.includes('from "./rule-priority"'));
    assert.equal(quoted.length, 2, "create and patch, no third copy");
    for (const line of quoted) assert.match(line, /min: PRIORITY_MIN, max: PRIORITY_MAX/);
  });

  it("refuses a ranking outside the range at the door that would store it", async () => {
    const create = {
      name: "ranked",
      trigger: "SCHEDULED",
      conditions: { tags: ["a"] },
      actions: { fields: ["seniority"], schedule: "* * * * *" },
      providers: ["derive"],
    };
    for (const priority of [PRIORITY_MAX + 1, PRIORITY_MIN - 1, 9_999_999]) {
      const result = validateBody({ ...create, priority }, RULE_CREATE);
      assert.equal(result.ok, false, `${priority} should not be stored`);
      const message = await refusal(result);
      assert.match(message, new RegExp(`priority must be at most ${PRIORITY_MAX}|priority must be at least ${PRIORITY_MIN}`), "and the refusal names the bound");
    }
    for (const priority of [PRIORITY_MIN, 1, 50, PRIORITY_MAX]) {
      const result = validateBody({ ...create, priority }, RULE_CREATE);
      assert.equal(result.ok, true, `${priority} is a ranking the walk can use: ${await refusal(result)}`);
    }
  });

  it("refuses a ranking that is not a whole number, quoted or fractional", async () => {
    const create = {
      name: "ranked",
      trigger: "SCHEDULED",
      conditions: { tags: ["a"] },
      actions: { fields: ["seniority"], schedule: "* * * * *" },
      providers: ["derive"],
    };
    for (const priority of ["2", 1.5, null]) {
      const result = validateBody({ ...create, priority }, RULE_CREATE);
      assert.equal(result.ok, false, `${JSON.stringify(priority)} is not a rank`);
    }
    // An absent key means the caller said nothing about the ranking, and the column's own
    // default answers it — which is what `ranked: 0` means in the walk.
    const absent = validateBody(create, RULE_CREATE);
    assert.equal(absent.ok, true);
    assert.equal("priority" in (absent.data ?? {}), false, "and the door never invents one");
  });

  it("still accepts the rule this repo ships", async () => {
    // The same argument #32 made about its declaration: a door widened after the seed was
    // written is a fresh install that cannot install.
    assert.match(seed, /priority: (\d+),/);
    const stored = Number(seed.match(/priority: (\d+),/)![1]);
    const result = validateBody(
      { name: "Auto-enrich new leads", trigger: "ON_CREATE", conditions: { status: "NEW" }, actions: { fields: ["email"] }, providers: ["apollo"], priority: stored },
      RULE_CREATE,
    );
    assert.equal(result.ok, true, `the seed's priority ${stored} must stay storable: ${await refusal(result)}`);
  });
});

describe("the ranking is a total order, and it is spelled once", () => {
  it("puts the higher rank first, whatever the order it arrived in", () => {
    const ten = ranked("rule-ten", 10, 0);
    const ninety = ranked("rule-ninety", 90, 1);
    const fifty = ranked("rule-fifty", 50, 2);
    assert.deepEqual(rankRules([ten, ninety, fifty]).map((r) => r.priority), [90, 50, 10], "the measured before-state read 50, 90, 10");
    assert.deepEqual(rankRules([fifty, ten, ninety]).map((r) => r.id), ["rule-ninety", "rule-fifty", "rule-ten"], "and input order changes nothing");
  });

  it("breaks a tie by the row that has been waiting longer", () => {
    const older = ranked("rule-older", 30, 0);
    const newer = ranked("rule-newer", 30, 5);
    assert.deepEqual(rankRules([newer, older]).map((r) => r.id), ["rule-older", "rule-newer"]);
    assert.ok(compareByPriority(older, newer) < 0, "and the comparator says the same thing");
  });

  it("breaks a tie in the same millisecond by id, so the order is total", () => {
    const a = ranked("rule-a", 30, 2);
    const b = ranked("rule-b", 30, 2);
    assert.equal(compareByPriority(a, b), -1);
    assert.equal(compareByPriority(b, a), 1, "antisymmetric, so no sort is at the mercy of input order");
    assert.equal(compareByPriority(a, { ...a }), 0, "and equal only to itself");
  });

  it("lists exactly the three keys the comparator uses, in the same directions", () => {
    // The SQL mirror and the in-memory walk are one rule. If these drift, the door shows one
    // ranking and the sweep applies another — which is the bug this round is about.
    assert.deepEqual(RULE_PRIORITY_ORDER, [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }]);
    const first = ranked("r-first", 1, 0);
    const second = ranked("r-second", 2, 0);
    const bySql = [first, second].sort((a, b) => {
      for (const clause of RULE_PRIORITY_ORDER) {
        const key = Object.keys(clause)[0] as "priority" | "createdAt" | "id";
        const dir = clause[key] === "desc" ? -1 : 1;
        const left = a[key] instanceof Date ? a[key].getTime() : a[key];
        const right = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (left !== right) return left > right ? dir : -dir;
      }
      return 0;
    });
    assert.deepEqual(bySql.map((r) => r.id), ["r-second", "r-first"], "both agree the higher rank is first");
    assert.deepEqual(rankRules([first, second]).map((r) => r.id), bySql.map((r) => r.id), "the walk and the query order the same pair the same way");
  });

  it("does not reorder the caller's array", () => {
    const rows = [ranked("rule-x", 1, 0), ranked("rule-y", 9, 1)];
    rankRules(rows);
    assert.deepEqual(rows.map((r) => r.id), ["rule-x", "rule-y"], "the sweep keeps its own order to log against");
  });
});

describe("planTick: who owns which column this minute", () => {
  it("leaves a lone rule with everything it asked for", () => {
    const only = ranked("rule-only", 5, 0, { fields: ["seniority", "companySize"] });
    const plan = planTick([only]);
    assert.deepEqual(owned(plan), [["rule-only", ["seniority", "companySize"]]], "in its own declared order");
    assert.deepEqual(plan.starved, []);
  });

  it("gives the column to the higher rank and leaves the lower one nothing to queue", () => {
    const high = ranked("rule-high", 90, 0, { fields: ["seniority"] });
    const low = ranked("rule-low", 10, 1, { fields: ["seniority"] });
    const plan = planTick([low, high]);
    assert.deepEqual(owned(plan), [["rule-high", ["seniority"]]]);
    assert.deepEqual(plan.starved.map((skipped) => [skipped.rule.id, skipped.asked]), [["rule-low", ["seniority"]]]);
  });

  it("lets the lower rank visit the column the higher one did not ask for", () => {
    const high = ranked("rule-high", 90, 0, { fields: ["seniority", "industry"] });
    const low = ranked("rule-low", 10, 1, { fields: ["seniority", "companySize"] });
    assert.deepEqual(owned(planTick([low, high])), [
      ["rule-high", ["seniority", "industry"]],
      ["rule-low", ["companySize"]],
    ], "the overlap is claimed, the rest is still worked, in the lower rule's own order");
  });

  it("treats a rule that says nothing about columns as a rule that wants them all", () => {
    // Round #32's reading, kept: an absent list is the rule saying nothing, not a rule
    // asking for nothing. Saying nothing is the widest ask there is.
    assert.deepEqual(unclaimedFields(null, new Set()), [...ENRICH_WRITABLE]);
    const broad = ranked("rule-broad", 90, 0, {});
    const narrow = ranked("rule-narrow", 10, 1, { fields: ["seniority"] });
    const plan = planTick([narrow, broad]);
    assert.deepEqual(owned(plan), [["rule-broad", [...ENRICH_WRITABLE]]]);
    assert.deepEqual(plan.starved.map((skipped) => skipped.rule.id), ["rule-narrow"]);
  });

  it("changes nothing for a rule that stands alone in its workspace", () => {
    // The equality that keeps #32's demo true: narrowing an answer to the full writable set
    // removes nothing, so a single due rule behaves exactly as it did before the ranking.
    const alone = ranked("rule-alone", PRIORITY_DEFAULT, 0, { fields: ["seniority"] });
    const [visit] = planTick([alone]).visits;
    const answer = { seniority: "C_LEVEL", industry: "Training" };
    assert.deepEqual(restrictToDeclared(answer, visit.fields), { seniority: "C_LEVEL" }, "the rule's own list still narrows");
    assert.deepEqual(unclaimedFields(null, new Set()).length, ENRICH_WRITABLE.length);
    assert.deepEqual(restrictToDeclared(answer, unclaimedFields(null, new Set())), answer, "and an unqualified rule narrows nothing away");
  });

  it("never lets one tenant starve another for the same column", () => {
    const a = ranked("rule-a", 90, 0, { fields: ["seniority"] }, "ws-a");
    const b = ranked("rule-b", 10, 1, { fields: ["seniority"] }, "ws-b");
    assert.deepEqual(
      Object.fromEntries(owned(planTick([b, a]))),
      { "rule-a": ["seniority"], "rule-b": ["seniority"] },
      "the claim set is per workspace, because the sweep walks every workspace's rules at once",
    );
  });

  it("decides by what a rule asked for, not by what a provider happens to answer", () => {
    // `derive` never answers `industry`, so this rule fills nothing — and it still owns the
    // column for this minute. Ranking is a statement about intent the operator can read off
    // the rules, not about a provider's mood.
    const asks = ranked("rule-asks", 90, 0, { fields: ["industry"] });
    const wants = ranked("rule-wants", 10, 1, { fields: ["industry"] });
    const plan = planTick([asks, wants]);
    assert.deepEqual(owned(plan), [["rule-asks", ["industry"]]]);
    assert.deepEqual(plan.starved.map((skipped) => skipped.rule.id), ["rule-wants"]);
  });

  it("is the same plan every minute for the same rules", () => {
    const rows = [
      ranked("rule-1", 10, 0, { fields: ["seniority"] }),
      ranked("rule-2", 90, 1, { fields: ["seniority", "companySize"] }),
      ranked("rule-3", 90, 1, { fields: ["industry"] }),
      ranked("rule-4", 50, 2, {}),
    ];
    const once = JSON.stringify(planTick(rows), (_k, v) => (v instanceof Date ? v.toISOString() : v));
    const twice = JSON.stringify(planTick([...rows].reverse()), (_k, v) => (v instanceof Date ? v.toISOString() : v));
    assert.equal(once, twice, "input order cannot change the plan — that is what the id tie-break is for");
  });

  it("feeds the write plan the columns its own rule won, and no others", () => {
    // Composition with #29 and #33: the field list the sweep puts on the job is what the
    // worker narrows with, so the lower-ranked visit can only ever record the remainder.
    const high = ranked("rule-high", 90, 0, { fields: ["seniority"] });
    const low = ranked("rule-low", 10, 1, { fields: ["seniority", "industry"] });
    const [winner, loser] = planTick([low, high]).visits;
    const answer = { seniority: "C_LEVEL", industry: "Training" };
    const lead = { status: "NEW", email: "a@b.co", company: "Co", title: "Chief Operating Officer", seniority: null, industry: null } as never;
    const won = planEnrichmentWrite(lead, restrictToDeclared(answer, winner.fields));
    const left = planEnrichmentWrite(lead, restrictToDeclared(answer, loser.fields));
    assert.deepEqual(won.written, ["seniority"], "the higher rank fills the column it claimed");
    assert.deepEqual(loser.fields, ["industry"], "the lower rank is left with the rest");
    assert.deepEqual(left.before, { industry: null }, "and its audit is about that column alone");
  });

  it("subtracts what is claimed and keeps the rest in order", () => {
    const claimed = new Set(["seniority", "company"]);
    assert.deepEqual(unclaimedFields(["companySize", "seniority", "industry"], claimed), ["companySize", "industry"]);
    assert.deepEqual(unclaimedFields(["seniority"], claimed), [], "a rule left with nothing asks for nothing");
    assert.deepEqual(unclaimedFields([], claimed), [], "an empty declared list is empty before the walk, not after it");
  });
});

describe("the wiring, from the source", () => {
  it("orders every rule list in src by the ranking", () => {
    // Not just the three this round knows about: a fourth reader added later is the same
    // bug back again, and the fix is the constant.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "generated" ? [] : walk(p);
        return p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
      });
    const files = walk(new URL("../../src", import.meta.url).pathname);
    const offenders: string[] = [];
    for (const file of files) {
      const code = blankComments(readFileSync(file, "utf8"));
      const queries = code.split("enrichmentRule.findMany(").length - 1;
      const ordered = code.split("orderBy: RULE_PRIORITY_ORDER").length - 1;
      if (queries !== ordered) offenders.push(`${file}: ${queries} queries, ${ordered} ordered`);
    }
    assert.deepEqual(offenders, [], "no rule list left reading the heap");
  });

  it("shows the operator the ranking they set, not the order rows arrived in", () => {
    const body = blankComments(functionBody(listDoor, "GET_impl")!);
    assert.match(body, /orderBy: RULE_PRIORITY_ORDER/);
    assert.ok(!/orderBy: \{ createdAt: "desc" \}/.test(body), "the old sort is gone, not kept beside it");
    assert.match(blankComments(listDoor), /from "@\/lib\/rule-priority"/);
  });

  it("walks the plan in the minute's sweep, and only after the checks that skip a rule", () => {
    const body = functionBody(scheduler, "runScheduledJobs")!;
    const code = blankComments(body);
    assert.match(code, /orderBy: RULE_PRIORITY_ORDER/);
    assert.match(code, /if \(!matchesSchedule\(declared\.schedule \?\? "", now\)\) continue;/, "a rule not due this minute is not in the running");
    assert.ok(code.indexOf("stored.problem !== null") < code.indexOf("due.push("), "unreadable conditions never claim a column");
    assert.ok(code.indexOf("performed !== null") < code.indexOf("due.push("), "and neither does an unperformable declaration");
    assert.ok(code.indexOf("planTick(due)") < code.indexOf("prisma.lead.findMany"), "the claims are settled before any crowd is read");
    assert.match(code, /config: \{ providers: rule\.providers, fields,/, "the job carries what this rule owns");
    assert.ok(!/declared\.fields \?\? \[\]/.test(code), "and no longer the whole ask of a rule that lost part of it");
  });

  it("says so in the log when the ranking leaves a rule with nothing", () => {
    const body = blankComments(functionBody(scheduler, "runScheduledJobs")!);
    assert.match(body, /for \(const starved of plan\.starved\)/);
    assert.match(body, /queued nothing this minute/);
    assert.match(body, /owned this minute by a higher-ranked rule/);
    assert.ok(body.indexOf("plan.starved") < body.indexOf("plan.visits"), "the skip is reported before the visits it made unnecessary");
  });

  it("runs the idle copy through the same walk, so two owners cannot be decided", () => {
    const body = blankComments(functionBody(enrichment, "runScheduledEnrichment")!);
    assert.match(body, /orderBy: RULE_PRIORITY_ORDER/);
    assert.match(body, /const plan = planTick\(due\)/);
    assert.match(body, /fields,/);
    assert.ok(body.indexOf("readStoredConditions(rule.conditions)") < body.indexOf("due.push("), "the same skip-then-claim order as the live sweep");
  });

  it("does not rank a visit somebody asked for by hand", () => {
    // `?action=run` names one rule and one crowd. The operator outranks the table, so the
    // only narrowing there is still that rule's own declaration — #32's behaviour, pinned so
    // a future ranking fix cannot quietly start skipping the door that says "run this now".
    const runDoor = at("../../src/app/api/enrichment-rules/[id]/route.ts");
    const body = blankComments(functionBody(runDoor, "POST_impl")!);
    assert.ok(!/planTick|RULE_PRIORITY_ORDER|starved/.test(body), "no ranking in the manual path at all");
    assert.match(body, /fields: performed\.fields \?\? \[\]/);
  });

  it("keeps #33's audit as the record of who won", () => {
    // The reason this round is measurable at all: the winning visit logs the gap it filled
    // and the refusal that follows logs the value it found there.
    const lead: EnrichableLead = { status: "NEW", email: "a@b.co", company: "Co", title: "Chief Operating Officer", seniority: null };
    const first = planEnrichmentWrite(lead, { seniority: "C_LEVEL" });
    assert.deepEqual([first.written, first.before, first.logStatus], [["seniority"], { seniority: null }, "SUCCESS"]);
    const after: EnrichableLead = { ...lead, seniority: "C_LEVEL", status: "ENRICHED" };
    const second = planEnrichmentWrite(after, { seniority: "C_LEVEL" });
    assert.deepEqual([second.written, second.before, second.logStatus], [[], { seniority: "C_LEVEL" }, "PARTIAL"]);
  });
});
