// The one grammar this build reads a cron with, and the one matcher that acts on it.
//
// #38 measured the gap with the app running. Four sources were created through
// `POST /api/sources` in the same minute and left for four sweep minutes:
//
// | stored `schedule` | what it asks for                | `Job` rows the sweep made |
// |-------------------|---------------------------------|---------------------------|
// | `*/5 * * * *`     | a scrape every fifth minute     | **0** — the window held :20 and :25 |
// | `0 9 * * 1-5`     | a scrape on weekday mornings    | **0** |
// | `* * * * * 1`     | a scrape restricted to one weekday | **4** — one per minute, every day |
// | `* * * * *`       | a scrape every minute (control) | 4 — the sweep was alive |
//
// The first two are silence: the matcher split each field on commas and compared whole
// strings, so `*/5` is not a coarser cadence, it is a cadence no minute can ever equal. The
// third is worse than silence — a six-field expression was read as its first five fields, so
// the one field that was supposed to restrict the scrape to a weekday was the field that got
// dropped, and an operator who asked for Monday got every minute of every day. Nothing was
// printed in any of the three cases.
//
// The same three strings were refused with a 400 by `POST /api/enrichment-rules`, each
// refusal quoting the offending part and saying that steps and ranges are not matched, so
// such a rule would never fire. That refusal was correct the day it shipped and it was scoped
// to one door: two doors take a cron, and the source door is the only cadence a buyer can set
// without a seed script. So this module is both halves of the fix — the matcher learned the
// grammar the column advertises, and every door that stores one asks this module before it
// writes.
//
// What it honours: `*`, a whole number, a comma list of either, an inclusive range `a-b`, and
// a step `*/n`, `a-b/n` or `a/n`. Day of week takes `7` as Sunday's other spelling and folds
// it to `0` on the way in. What it refuses, by name, with the offending part quoted: `?`, `L`,
// `W`, `#`, weekday and month names, a step of `0`, a reversed range, a number outside its
// field, an empty entry between commas, and anything that is not exactly five fields — and,
// since #61, a day and a month that are each in range but have no date in common.
//
// One semantic choice is stated rather than inherited. Vixie cron matches a cadence that
// restricts both day of month and day of week when *either* one matches; this matcher has
// always required both, and #38 keeps that, because rows stored under the old matcher mean
// what it said. Quietly widening every "the 15th and a Monday" in a live database to "the 15th
// or any Monday" would be the same class of surprise this round exists to close.

export type ScheduleFieldSpec = {
  /** The name a refusal uses, so the message says which field it is talking about. */
  name: string;
  lo: number;
  hi: number;
  /** Values the grammar accepts that mean something else to the clock: `{ 7: 0 }`. */
  fold?: Record<number, number>;
};

/** The five fields a cadence is read as, in order, with what each one may hold. */
export const SCHEDULE_FIELDS: readonly ScheduleFieldSpec[] = [
  { name: "minute", lo: 0, hi: 59 },
  { name: "hour", lo: 0, hi: 23 },
  { name: "day of month", lo: 1, hi: 31 },
  { name: "month", lo: 1, hi: 12 },
  // `7` is Sunday in the same tradition `0` is Sunday in; both are accepted, and folded.
  { name: "day of week", lo: 0, hi: 7, fold: { 7: 0 } },
];

/** `0  9 * *  1` and `0 9 * * 1` ask the same question of the same clock. */
export function canonicalSchedule(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

/** What a field may hold, in the words every refusal this round writes. */
export const GRAMMAR = 'must be "*" or a whole number, a comma-separated list, an inclusive range "a-b", or a step "*/n", "a-b/n", "a/n"';

// One comma-free entry: `*`, `n`, `a-b`, `*/n`, `a/n`, `a-b/n` — nothing else.
const ENTRY = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

function boundProblem(raw: string, spec: ScheduleFieldSpec): string | null {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return `${spec.name} "${raw}" is not a whole number`;
  if (n < spec.lo || n > spec.hi) return `${spec.name} "${raw}" holds ${n}, outside ${spec.lo}-${spec.hi}`;
  return null;
}

/** Every value one comma-free entry holds, or why it holds none. */
function expandEntry(entry: string, spec: ScheduleFieldSpec): number[] | string {
  const word = /[A-Za-z]+/.exec(entry);
  if (word !== null) {
    return `"${entry}" is not something this build's matcher reads — ${spec.name} ${GRAMMAR}; "${word[0]}" is a weekday or month name, or a Vixie extension like "L", and only numbers are read`;
  }
  if (/[?#]/.test(entry)) {
    return `"${entry}" holds a "?" or "#", which this build's matcher does not read — ${spec.name} ${GRAMMAR}`;
  }
  const matched = ENTRY.exec(entry);
  if (matched === null) {
    return `"${entry}" is not something this build's matcher reads — ${spec.name} ${GRAMMAR}`;
  }
  const [, head, rangeEnd, stepText] = matched;
  if (stepText !== undefined && Number(stepText) < 1) {
    return `"${entry}" steps by ${stepText}, which never advances — a step is 1 or more`;
  }
  const step = stepText === undefined ? 1 : Number(stepText);

  let from: number;
  let to: number;
  if (head === "*") {
    from = spec.lo;
    to = spec.hi;
  } else {
    const startProblem = boundProblem(head, spec);
    if (startProblem !== null) return startProblem;
    from = Number(head);
    if (rangeEnd === undefined) {
      to = stepText === undefined ? from : spec.hi;
    } else {
      const endProblem = boundProblem(rangeEnd, spec);
      if (endProblem !== null) return endProblem;
      if (Number(rangeEnd) < from) {
        return `"${entry}" is a range that runs backwards in ${spec.name}: ${head}-${rangeEnd}`;
      }
      to = Number(rangeEnd);
    }
  }

  const fold = spec.fold ?? {};
  const values: number[] = [];
  for (let current = from; current <= to; current += step) {
    const folded = fold[current] ?? current;
    if (!values.includes(folded)) values.push(folded);
  }
  return values.sort((a, b) => a - b);
}

/** Why one field of a cadence can never be matched, or `null`. */
export function scheduleFieldProblem(field: string, spec: ScheduleFieldSpec): string | null {
  if (field === "*") return null;
  const parts = field.split(",");
  if (parts.some((part) => part === "")) {
    return `"${field}" has an empty entry between its commas`;
  }
  for (const part of parts) {
    const expanded = expandEntry(part, spec);
    if (typeof expanded === "string") return expanded;
  }
  return null;
}

/** Every month's longest real day, January first. February is 29, not 28: leap years exist,
 * so `0 0 29 2 *` is a cadence that runs — measured, once in four years, on 2028-02-29. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Why the day field and the month field together name no date the calendar has, or `null`.
 *
 * Each field can be legal on its own and the pair still be empty: `0 0 30 2 *` asks for the
 * 30th of February, and no February has a 30th even though `30` is a day of month and `2` is a
 * month. `matchesSchedule` already answers that cadence `false` at every minute — this is the
 * half that says so out loud, so the door that stores it and the minute that reads it agree.
 *
 * Only the day and month fields are cross-checked. A day-of-week is not part of the verdict
 * because no combination of a real date and a weekday is unreachable: the weekday a date falls
 * on moves through the whole week over the leap-year cycle, so `0 0 29 2 1` is a cadence that
 * waits a long time rather than one that never comes.
 */
function dateProblem(parts: string[]): string | null {
  const [dayField, monthField] = [parts[2], parts[3]];
  if (scheduleFieldProblem(dayField, SCHEDULE_FIELDS[2]) !== null) return null;
  if (scheduleFieldProblem(monthField, SCHEDULE_FIELDS[3]) !== null) return null;
  const days = valuesFor(dayField, SCHEDULE_FIELDS[2]);
  const months = valuesFor(monthField, SCHEDULE_FIELDS[3]);
  if (days.length === 0 || months.length === 0) return null;
  const earliest = Math.min(...days);
  const longest = Math.max(...months.map((month) => DAYS_IN_MONTH[month - 1]));
  if (earliest <= longest) return null;
  return `day of month "${dayField}" is not a day of month "${monthField}" — the longest month it names has ${longest} days, so no minute of any year matches this cadence`;
}

/** Why this cadence can never be honoured, every problem in one message, or `null` when the
 * matcher can read it. Takes `unknown` because the doors hand it whatever the body held. */
export function scheduleProblem(value: unknown): string | null {
  if (typeof value !== "string") {
    return `schedule must be a cron expression of five fields — it is ${describe(value)}`;
  }
  const parts = canonicalSchedule(value).split(" ");
  if (parts.length !== SCHEDULE_FIELDS.length) {
    return `schedule "${value}" is ${parts.length} fields — this build reads exactly five (minute hour day-of-month month day-of-week)`;
  }
  const problems: string[] = [];
  parts.forEach((part, index) => {
    const problem = scheduleFieldProblem(part, SCHEDULE_FIELDS[index]);
    if (problem !== null) problems.push(problem);
  });
  // A cadence whose fields are each misfired is refused for its fields, not for its date:
  // the two complaints would be one message about two different things.
  if (problems.length === 0) {
    const noSuchDate = dateProblem(parts);
    if (noSuchDate !== null) problems.push(noSuchDate);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

function valuesFor(entry: string, spec: ScheduleFieldSpec): number[] {
  if (entry === "*") {
    const all: number[] = [];
    for (let n = spec.lo; n <= spec.hi; n += 1) {
      const folded = spec.fold?.[n] ?? n;
      if (!all.includes(folded)) all.push(folded);
    }
    return all;
  }
  const values: number[] = [];
  for (const part of entry.split(",")) {
    const expanded = expandEntry(part, spec);
    if (typeof expanded === "string") return [];
    for (const value of expanded) if (!values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * Does this clock tick match this cadence? Never throws and never widens: a cadence this
 * module would refuse answers `false`, so a caller that skipped the check still cannot run
 * work nobody asked for — it only cannot say why it is quiet, which is why the doors check and
 * the sweep logs.
 */
export function matchesSchedule(cadence: string, now: Date): boolean {
  const parts = canonicalSchedule(cadence).split(" ");
  if (parts.length !== SCHEDULE_FIELDS.length) return false;
  const clock = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];
  return parts.every((part, index) => valuesFor(part, SCHEDULE_FIELDS[index]).includes(clock[index]));
}
