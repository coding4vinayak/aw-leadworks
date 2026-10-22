// #38 — the cron a buyer can store is the cron the sweep reads, pinned offline.
//
// Measured against the running app before any of this shipped. Four sources were created
// through `POST /api/sources` in the same minute and left for four sweep minutes:
//
//   - `*/5 * * * *` — stored with a 201, and **0 `Job` rows**, across a window that
//     contained minute :20 and minute :25. The matcher split each field on "," and
//     compared whole strings, so a step is not a coarser cadence; it is a cadence no
//     minute can ever equal.
//   - `0 9 * * 1-5` — same: stored, **0 jobs**, forever.
//   - `* * * * * 1` — six fields, so `parts.length < 5` was false and the matcher read
//     the *first five*: **4 jobs, one per minute, every day of the week**. The field that
//     was supposed to restrict the scrape to Monday was the field that got dropped.
//   - `* * * * *` — the control: 4 jobs, which is what proves the other three were the
//     sweep being deaf rather than the sweep being down.
//
//   Meanwhile `POST /api/enrichment-rules` answered all three of the failing strings with
//   a 400 quoting the offending part — the refusal lived in `rule-actions.ts`, next to a
//   re-spelled copy of the field table, and the two doors that store a `schedule` column
//   (sources, and the profiles the seed writes) asked for none of it.
//
// So this file pins three things: the matcher's known answers, including the two shapes
// #34 refused on the matcher's behalf and #38 taught the matcher; the grammar's refusals,
// each naming the part it refuses; and the wiring — one module spelling the ranges, the
// three sweep legs asking it, both source doors refusing with the same call, and the
// deleted matcher gone from `src/` rather than kept beside its replacement.
//
// Nothing here needs a database: the clock arrives as an argument.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import {
  GRAMMAR,
  SCHEDULE_FIELDS,
  canonicalSchedule,
  matchesSchedule,
  scheduleFieldProblem,
  scheduleProblem,
} from "../../src/lib/cron-schedule";
import { actionsProblem, readRuleActions } from "../../src/lib/rule-actions";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });

/** A Thursday in October 2026, at a minute the fixtures name. */
const THU = (hour: number, minute: number) => new Date(2026, 9, 22, hour, minute);
const SUN = (hour: number, minute: number) => new Date(2026, 9, 25, hour, minute);
const MON = (hour: number, minute: number) => new Date(2026, 9, 26, hour, minute);

describe("the matcher: known answers on fixed clocks", () => {
  it("keeps every cadence the old matcher could read", () => {
    assert.equal(matchesSchedule("* * * * *", THU(3, 17)), true);
    assert.equal(matchesSchedule("0 9 * * *", THU(9, 0)), true);
    assert.equal(matchesSchedule("0 9 * * *", THU(9, 1)), false, "one minute off is not a rounding error");
    assert.equal(matchesSchedule("0 9 * * *", THU(8, 0)), false);
    assert.equal(matchesSchedule("30 8,12 * * 0,6", SUN(12, 30)), true);
    assert.equal(matchesSchedule("30 8,12 * * 0,6", THU(12, 30)), false, "Thursday is in neither list");
    assert.equal(matchesSchedule("0 9 * 1,6 1", new Date(2026, 5, 15, 9, 0)), true, "June, a Monday, 9:00");
  });

  it("reads a step, which is the shape the measurement died on", () => {
    const fired: number[] = [];
    for (let minute = 0; minute < 60; minute += 1) {
      if (matchesSchedule("*/5 * * * *", THU(3, minute))) fired.push(minute);
    }
    assert.deepEqual(fired, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55], "12 of 60 minutes, and they are the fifth ones");
    assert.equal(matchesSchedule("*/1 * * * *", THU(3, 37)), true, "a step of 1 is the every-minute cadence it says");
    assert.equal(matchesSchedule("*/45 * * * *", THU(3, 45)), true, "a step wider than half the field still yields its start");
    assert.equal(matchesSchedule("10/15 * * * *", THU(3, 25)), true, "a step from a start runs to the end of the field");
    assert.equal(matchesSchedule("10/15 * * * *", THU(3, 5)), false, "and never wraps below the start");
  });

  it("reads a range, and a range with a step", () => {
    assert.equal(matchesSchedule("0 9 * * 1-5", THU(9, 0)), true);
    assert.equal(matchesSchedule("0 9 * * 1-5", MON(9, 0)), true);
    assert.equal(matchesSchedule("0 9 * * 1-5", SUN(9, 0)), false, "Sunday is outside 1-5");
    assert.equal(matchesSchedule("5-20/10 * * * *", THU(3, 15)), true);
    assert.equal(matchesSchedule("5-20/10 * * * *", THU(3, 25)), false, "a range bounds where its step stops");
    assert.equal(matchesSchedule("*/15 9-17 * * 1-5", new Date(2026, 9, 22, 13, 30)), true, "three restricted fields at once");
    assert.equal(matchesSchedule("*/15 9-17 * * 1-5", new Date(2026, 9, 22, 18, 30)), false, "the hour range is not decorative");
  });

  it("takes 7 as Sunday's other spelling, and folds it before matching", () => {
    assert.equal(matchesSchedule("0 9 * * 7", SUN(9, 0)), true);
    assert.equal(matchesSchedule("0 9 * * 0", SUN(9, 0)), true, "the two spellings answer the same clock");
    assert.equal(matchesSchedule("0 9 * * 7", MON(9, 0)), false);
    assert.equal(matchesSchedule("0 9 * * 5-7", SUN(9, 0)), true, "a range that wraps past 6 reaches Sunday");
  });

  it("requires both a day of month and a day of week, and says so", () => {
    // Vixie cron means "either" when both fields are restricted. This matcher has always
    // meant "both", and #38 kept it rather than silently widening rows stored under the
    // old one — so the choice is a pinned behaviour, not a comment someone can forget.
    assert.equal(matchesSchedule("0 12 15 * 1", new Date(2026, 5, 15, 12, 0)), true, "the 15th and a Monday");
    assert.equal(matchesSchedule("0 12 15 * 1", new Date(2026, 6, 15, 12, 0)), false, "the 15th of a Wednesday is not it");
    assert.equal(matchesSchedule("0 12 15 * 1", new Date(2026, 6, 20, 12, 0)), false, "a Monday that is not the 15th is not it either");
  });

  it("matches a cadence that cannot fall on the calendar as never, not as an error", () => {
    assert.equal(matchesSchedule("0 0 30 2 *", new Date(2026, 1, 28, 0, 0)), false, "February 2026 has 28 days");
    assert.equal(scheduleProblem("0 0 30 2 *"), null, "and it is still a well-formed cron — refusing it would be inventing a rule");
  });

  it("reads the same clock whatever the whitespace", () => {
    assert.equal(matchesSchedule("  30   9 * *  1 ", MON(9, 30)), true);
    assert.equal(canonicalSchedule("  0   9 * * 1  "), "0 9 * * 1");
  });

  it("answers false for a cadence it would refuse, so no caller can run unscheduled work", () => {
    for (const junk of ["*/5 * * * * *", "0 9 * * MON", "*/0 * * * *", "nonsense", "", "61 * * * *"]) {
      assert.equal(scheduleProblem(junk) !== null, true, `${junk} is refused by name`);
      assert.equal(matchesSchedule(junk, THU(9, 0)), false, `${junk} matches nothing, even checked by a caller that skipped the refusal`);
    }
  });
});

describe("the grammar: every refusal names the part it refuses", () => {
  it("refuses a cadence that is not five fields, counting what it was given", () => {
    assert.match(scheduleProblem("* * * *")!, /is 4 fields/);
    assert.match(scheduleProblem("* * * * * 1")!, /is 6 fields/, "the shape the measurement stored as a working schedule");
    assert.match(scheduleProblem("")!, /is 1 fields/);
    assert.match(scheduleProblem(["* * * * *"])!, /it is an array/, "a JSON array is not a cron");
    assert.match(scheduleProblem(5)!, /it is 5/);
    assert.match(scheduleProblem(null)!, /it is null/);
    assert.equal(scheduleProblem(undefined), 'schedule must be a cron expression of five fields — it is undefined', "absent is a string this function is asked about, not a verdict");
  });

  it("refuses a name, and says which convention it belongs to", () => {
    const weekday = scheduleProblem("0 9 * * MON-FRI")!;
    assert.ok(weekday.includes('"MON-FRI"'), `the offending field is quoted back, got: ${weekday}`);
    assert.match(weekday, /is not something this build's matcher reads/);
    assert.match(weekday, /day of week must be/, "and the position it belongs to");
    assert.match(weekday, /weekday or month name/);
    assert.match(scheduleProblem("0 0 1 JAN *")!, /matcher reads — month must be/);
    assert.match(scheduleProblem("0 9 * * sun")!, /"sun"/, "case is not an escape hatch");
  });

  it("refuses the placeholders and extensions it does not read", () => {
    assert.match(scheduleProblem("0 0 ? * 1")!, /holds a "\?" or "#"/);
    assert.match(scheduleProblem("0 0 * * 1#2")!, /holds a "\?" or "#"/);
    assert.match(scheduleProblem("0 0 L * *")!, /day of month/);
    assert.match(scheduleProblem("0 0 LW * *")!, /day of month/);
  });

  it("refuses a step that cannot advance and a range that runs backwards", () => {
    assert.match(scheduleProblem("*/0 * * * *")!, /"\*\/0" steps by 0, which never advances/);
    assert.match(scheduleProblem("5-20/0 * * * *")!, /steps by 0/);
    assert.match(scheduleProblem("20-5 * * * *")!, /runs backwards in minute: 20-5/);
    assert.match(scheduleProblem("*/2/3 * * * *")!, /is not something this build's matcher reads/);
    assert.match(scheduleProblem("1-5-9 * * * *")!, /is not something this build's matcher reads/);
  });

  it("refuses a number outside the field it is in, and keeps the entry list honest", () => {
    assert.match(scheduleProblem("60 * * * *")!, /minute "60" holds 60, outside 0-59/);
    assert.match(scheduleProblem("0 25 * * *")!, /hour "25" holds 25, outside 0-23/);
    assert.match(scheduleProblem("0 9 0 * *")!, /day of month "0" holds 0, outside 1-31/);
    assert.match(scheduleProblem("0 9 * 13 *")!, /month "13" holds 13, outside 1-12/);
    assert.match(scheduleProblem("0 9 * * 8")!, /day of week "8" holds 8, outside 0-7/);
    assert.match(scheduleProblem("0, 9 * * *")!, /"0," has an empty entry between its commas/);
    assert.match(scheduleProblem("1,,2 * * * *")!, /has an empty entry/);
    assert.match(scheduleProblem("1-70 * * * *")!, /outside 0-59/, "a range checks both of its ends");
  });

  it("reports every field's problem in one message", () => {
    const problem = scheduleProblem("61 25 32 13 9")!;
    assert.equal(problem.split("; ").length, 5, "five fields, five problems, one call");
  });

  it("states the accepted shapes once, in the words every refusal quotes", () => {
    assert.match(GRAMMAR, /inclusive range "a-b"/);
    assert.match(GRAMMAR, /step "\*\/n"/);
    const problem = scheduleProblem("*/5 * * * MON")!;
    assert.ok(problem.includes(GRAMMAR), "the message carries the grammar rather than a paraphrase of it");
  });

  it("asks per field, so a caller with a field in hand gets a verdict about that field", () => {
    assert.equal(scheduleFieldProblem("*", SCHEDULE_FIELDS[0]), null);
    assert.equal(scheduleFieldProblem("*/5", SCHEDULE_FIELDS[0]), null);
    assert.equal(scheduleFieldProblem("*/5", SCHEDULE_FIELDS[1]), null, "a step is a step in every field");
    assert.equal(scheduleFieldProblem("0-23", SCHEDULE_FIELDS[1]), null);
    assert.match(scheduleFieldProblem("24", SCHEDULE_FIELDS[1])!, /outside 0-23/);
    assert.equal(scheduleFieldProblem("7", SCHEDULE_FIELDS[4]), null, "Sunday's other spelling is inside the field");
    assert.match(scheduleFieldProblem("8", SCHEDULE_FIELDS[4])!, /outside 0-7/);
  });
});

describe("one table of ranges, one grammar, and the doors that use them", () => {
  it("is the only module under src that spells the five fields", () => {
    const spellers = srcFiles(srcDir).filter((file) => {
      const code = blankComments(readFileSync(file, "utf8"));
      return /name: "minute"/.test(code) || /name: "day of month"/.test(code);
    });
    assert.deepEqual(spellers.map((file) => file.split("/").pop()), ["cron-schedule.ts"], "the ranges are spelled once");
    assert.deepEqual(
      SCHEDULE_FIELDS.map((f) => `${f.name} ${f.lo}-${f.hi}`),
      ["minute 0-59", "hour 0-23", "day of month 1-31", "month 1-12", "day of week 0-7"],
    );
  });

  it("holds no import, no clock of its own and no filesystem", () => {
    const code = blankComments(at("../../src/lib/cron-schedule.ts"));
    assert.ok(!/^import /m.test(code), "a pure module: nothing to reach the database or the disk with");
    assert.ok(!/new Date\(\s*\)/.test(code), "the clock arrives as an argument, so every known answer above is reproducible");
    assert.ok(!/Date\.now|setTimeout|setInterval/.test(code), "and no wall clock is read behind the caller's back");
    assert.equal(code.includes("process.env"), false, "no policy is tunable from outside the call");
  });

  it("does not mutate what it was handed", () => {
    const before = structuredClone(SCHEDULE_FIELDS);
    scheduleProblem("*/0 * * * MON");
    matchesSchedule("0 9 * * 5-7", SUN(9, 0));
    assert.deepEqual(SCHEDULE_FIELDS, before, "the table the doors quote is the table the matcher read");
  });

  it("agrees with the rule door on every cadence in one table", () => {
    // The two verdicts are computed by different code paths — `actionsProblem` for the rule,
    // `scheduleProblem` for the column — over the same module. A cadence one accepts and the
    // other refuses is the bug this round measured, wearing a different hat.
    const table = [
      "* * * * *", "0 9 * * *", "*/5 * * * *", "0 9 * * 1-5", "*/15 9-17 * * 1-5",
      "10/15 * * * *", "30 8,12 * * 0,6", "0 0 1 1 *", "0 9 * * 7", "0 12 15 * 1",
      "*/0 * * * *", "0 9 * * MON-FRI", "* * * * * 1", "60 * * * *", "0, 9 * * *",
      "20-5 * * * *", "0 0 ? * 1", "nonsense", "",
    ];
    for (const cron of table) {
      const matcher = scheduleProblem(cron);
      const rule = actionsProblem({ fields: ["seniority"], schedule: cron });
      if (matcher === null) {
        assert.equal(rule, null, `${cron} is honoured by the matcher, so the rule door must not refuse it`);
      } else {
        assert.notEqual(rule, null, `${cron} the matcher cannot read must not be storable on a rule`);
        assert.ok(rule!.includes(matcher!), `the rule refusal carries the matcher's own sentence for ${cron}: ${rule}`);
      }
    }
  });

  it("keeps the reader honest about what it will not hand back", () => {
    assert.equal(readRuleActions({ schedule: "*/5 * * * *" }).schedule, "*/5 * * * *", "a step is a cadence now");
    assert.equal(readRuleActions({ schedule: "0 9 * * MON" }).schedule, null, "a name is not");
  });

  it("retired the matcher it replaced, rather than leaving two", () => {
    const offenders = srcFiles(srcDir).filter((file) => /shouldRunNow|Simplified cron matching/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, [], "no definition, no call, no comment naming the deleted function");
  });
});

describe("the wiring, from the source", () => {
  const scheduler = at("../../src/lib/scheduler.ts");
  const createDoor = at("../../src/app/api/sources/route.ts");
  const editDoor = at("../../src/app/api/sources/[id]/route.ts");

  it("asks the matcher three times in the minute, once per leg that stores a schedule", () => {
    const body = blankComments(functionBody(scheduler, "runScheduledJobs")!);
    assert.equal((body.match(/matchesSchedule\(/g) ?? []).length, 3, "source, profile, rule");
    assert.match(body, /matchesSchedule\(source\.schedule, now\)/);
    assert.match(body, /matchesSchedule\(profile\.schedule, now\)/);
    assert.match(body, /if \(!matchesSchedule\(declared\.schedule \?\? "", now\)\) continue;/, "the rule leg asks the reader's cadence");
    assert.ok(!/getMinutes|getHours|getDate\(\)|getDay\(\)/.test(body), "the sweep never reads the clock to compare it itself");
  });

  it("checks a stored column before matching it, and says which row is quiet", () => {
    const body = blankComments(functionBody(scheduler, "runScheduledJobs")!);
    for (const [leg, label] of [["source", "Source"], ["profile", "Export profile"]] as const) {
      const checked = body.indexOf(`scheduleProblem(${leg}.schedule)`);
      const matched = body.indexOf(`matchesSchedule(${leg}.schedule, now)`);
      assert.ok(checked > -1, `the ${leg} leg asks the grammar`);
      assert.ok(matched > checked, `and only matches what the grammar accepted`);
      const warned = body.indexOf(`console.warn(\`${label}`);
      assert.ok(warned > checked && warned < matched, `an unreadable ${leg} cadence is named in the log before it is skipped`);
      assert.ok(body.indexOf("continue;", warned) < matched, "and skipped, not matched by luck");
    }
    assert.match(body, /const plan = planTick\(due\)/, "the rule leg still claims columns after the cadence question");
  });

  it("refuses an unreadable cadence on both source doors, before either writes", () => {
    for (const [door, write] of [[createDoor, "prisma.source.create"], [editDoor, "prisma.source.update"]] as const) {
      const code = blankComments(door);
      assert.ok(code.includes('from "@/lib/cron-schedule"'), "the door imports the matcher's grammar");
      const refused = code.indexOf("scheduleProblem(input.data.schedule)");
      assert.ok(refused > -1, `${write} checks the cadence`);
      assert.ok(refused < code.indexOf(write), `and refuses before ${write} runs`);
      assert.match(code.slice(refused, code.indexOf(write)), /status: 400/, "with a 400 naming the problem");
    }
  });

  it("leaves a cleared cadence cleared, on the door that takes null", () => {
    const code = blankComments(editDoor);
    assert.match(code, /typeof input\.data\.schedule === "string"/, "so `null` — no cadence — is not a cadence to refuse");
    assert.equal(scheduleProblem(null) === null, false, "which is why the door gates before asking");
  });

  it("gates the field on the column's own type, not on a second list", () => {
    // `SOURCE_CREATE.schedule` is the nullable text the door validates; the cadence verdict
    // runs on whatever survives that, so a number is refused by the table and a string by
    // the grammar, in that order.
    assert.match(createDoor, /validateBody\(body, SOURCE_CREATE\)/);
    const create = functionBody(createDoor, "POST_impl")!;
    const code = blankComments(create);
    assert.ok(code.indexOf("validateBody") < code.indexOf("scheduleProblem(input.data.schedule)"), "shape first, cadence second");
    assert.ok(code.indexOf("scheduleProblem(input.data.schedule)") < code.indexOf("prisma.source.create"), "then the write");
  });
});
