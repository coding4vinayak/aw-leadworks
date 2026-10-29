// #63 — the sources door reads two words it had never heard of.
//
// Measured on the running app before any of this shipped, in this round's own runtime
// (`:3415` over database `leadworks_r64`, Redis 6406, logs `/tmp/opencode/r64_measure*.log`).
// Six sources, all of them created through `POST /api/sources` so the write door's own
// validation is what put them there: one per `SOURCE_TYPES` value, plus a `WEB_SCRAPER`
// with `schedule = "* * * * *"`. That last one is where the verdict came from — the sweep
// minted two `SCRAPE` jobs for it across two minute boundaries and both failed for want of
// a browser, writing the capability sentence into `Source.lastRunStatus` and
// `lastRunError`. So `?lastRunStatus=FAILED` below was asked of a table that genuinely held
// one `FAILED` row and five rows with no verdict at all, which is the only way this press
// could be honest:
//
//   GET /api/sources?type=API              200 total=6   all five types back
//   GET /api/sources?type=api              200 total=6   the word POST refuses in a body
//   GET /api/sources?type=nonsense         200 total=6
//   GET /api/sources?type=API&type=MANUAL  200 total=6
//   GET /api/sources?lastRunStatus=FAILED  200 total=6   the one real verdict, plus five rows that have none
//   GET /api/sources?lastRunStatus=SUCCESS 200 total=6
//   GET /api/sources?lastRunStatus=PARTIAL 200 total=6
//   GET /api/sources?lastRunStatus=nope    200 total=6
//   GET /api/sources?isActive=true         200 total=6   control — the one word this door does judge
//   POST /api/sources {"type":"api"}       400 type must be one of WEB_SCRAPER | API | DATABASE | CSV_UPLOAD | MANUAL, got "api"
//
// Eight presses, four spellings of `type` and four of `lastRunStatus`, and every one of
// them returned the whole table. This is not the defect `list-filter.ts` was written for:
// there the word reached Prisma unchecked and an empty page answered a mistyped filter.
// Here the word never reached anything. `GET_impl` read `isActive`, `page` and `limit` and
// ignored the rest of the query string, so `?type=API` and `?type=APIX` and no `type` were
// one answer — and the answer it gave was not even the one the caller asked for. A filter
// this door does not have was sold as a page that happens to hold everything, which is the
// worse of the two silences because the caller has no empty page to notice.
//
// The write door on the same column, same instance, same minute, named all five words. So
// the vocabulary existed and the schema comment existed; what was missing was the reader
// using them. `filterParam` is imported, not re-spelled, for exactly that reason — the door
// and `SOURCE_CREATE` cannot now drift into disagreeing about what `API` means.
//
// `PARTIAL` is the disagreement this round did not smooth over. `Source.lastRunStatus`'s
// schema comment declares `SUCCESS | FAILED | PARTIAL`; the code stamps two of them
// (`scraper.ts:145` SUCCESS, `scraper.ts:161` FAILED) and nothing writes the third. The set
// is transcribed from the comment as this file's own rule says to, so `?lastRunStatus=PARTIAL`
// is accepted and answers an empty page — the true answer to "did any source half-run",
// which no run in this app ever has. Narrowing the set to the two words the code writes
// would have made the table match the code and the door refuse a word the column documents;
// the pin below keeps both halves visible instead of picking one.
//
// Nothing here needs a browser, a database or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { SOURCE_RUN_STATUSES, SOURCE_TYPES } from "../../src/lib/enums";
import { filterParam } from "../../src/lib/list-filter";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(join(srcDir, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = join(srcDir, dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(join(dir, entry.name));
  });
const schema = at("../../prisma/schema.prisma");
const sourcesDoor = at("../../src/app/api/sources/route.ts");
const scraper = blankComments(at("../../src/lib/scraper.ts"));

/** The words one column's schema comment shows, in the order the file writes them. */
function commented(model: string, column: string): string[] {
  const block = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
  const found = new RegExp(`^\\s+${column}\\s+\\S+[^/]*// (.*)$`, "m").exec(block);
  assert.ok(found, `${model}.${column} has no comment set in prisma/schema.prisma to compare against`);
  return (found?.[1] ?? "").split("|").map((word) => word.trim());
}

/** Ask the sources door's filter the way the route does. */
const asked = (query: string, name: string, words: readonly string[]) =>
  filterParam(new URLSearchParams(query), name, words);

const typeAsk = (query: string) => asked(query, "type", SOURCE_TYPES);
const verdictAsk = (query: string) => asked(query, "lastRunStatus", SOURCE_RUN_STATUSES);

async function refusal(result: ReturnType<typeof filterParam>) {
  assert.ok(result.error, "the filter was expected to refuse");
  return { status: result.error.status, json: (await result.error.json()) as Record<string, unknown> };
}

test("every type the column holds is a type the door takes", () => {
  for (const word of SOURCE_TYPES) {
    const result = typeAsk(`type=${word}`);
    assert.equal(result.value, word, `?type=${word} filters for ${word}`);
    assert.equal(result.error, null);
  }
});

test("every verdict the column declares is a verdict the door takes", () => {
  for (const word of SOURCE_RUN_STATUSES) {
    const result = verdictAsk(`lastRunStatus=${word}`);
    assert.equal(result.value, word, `?lastRunStatus=${word} filters for ${word}`);
    assert.equal(result.error, null);
  }
});

test("a word outside the set is refused in the sentence the write door uses", async () => {
  for (const word of ["api", "Api", "WEBSCRAPER", "web_scraper", "MOON", "API,MANUAL"]) {
    const result = typeAsk(`type=${word}`);
    assert.equal(result.value, null, `${word} never reaches the where`);
    assert.equal(
      (await refusal(result)).json.error,
      `type must be one of ${SOURCE_TYPES.join(" | ")}, got "${word}"`,
      "one sentence for one column, at the door that writes it and the door that reads it",
    );
  }
  for (const word of ["success", "Cancelled", "RUNNING", "DONE", "null"]) {
    const result = verdictAsk(`lastRunStatus=${word}`);
    assert.equal(result.value, null, `${word} never reaches the where`);
    assert.equal(
      (await refusal(result)).json.error,
      `lastRunStatus must be one of ${SOURCE_RUN_STATUSES.join(" | ")}, got "${word}"`,
    );
  }
});

test("a word from a neighbouring column is not a verdict", async () => {
  // `FAILED` is a Job word and a Source word at once, which is fine; `COMPLETED` belongs to
  // neither column here, and `PARTIAL` belongs to `EnrichmentLog.status` as well as to this
  // comment — accepted because this column's own comment spells it, not because something
  // writes it.
  for (const word of ["COMPLETED", "PENDING", "PROCESSING"]) {
    assert.equal((await refusal(verdictAsk(`lastRunStatus=${word}`))).status, 400);
  }
  assert.equal(verdictAsk("lastRunStatus=FAILED").value, "FAILED");
  assert.equal(verdictAsk("lastRunStatus=PARTIAL").value, "PARTIAL");
});

test("the padding is not part of the word, and an empty one names nothing", () => {
  assert.equal(typeAsk("type=%20API").value, "API");
  assert.equal(typeAsk("type=API%20").value, "API");
  assert.equal(verdictAsk("lastRunStatus=%09FAILED%09").value, "FAILED");
  for (const result of [typeAsk("type="), typeAsk("type=%20"), verdictAsk("lastRunStatus=")]) {
    assert.equal(result.value, null, "an empty value is an absent filter, not a wrong one");
    assert.equal(result.error, null);
  }
});

test("the same word twice is one word and two words are a refusal", async () => {
  assert.equal(typeAsk("type=API&type=API&type=%20API").value, "API");
  assert.equal(
    (await refusal(typeAsk("type=API&type=MANUAL"))).json.error,
    'type was given 2 words ("API", "MANUAL"); this filter compares type to one of them',
    "measured on the base build as total=6, the whole table",
  );
  assert.match(
    (await refusal(verdictAsk("lastRunStatus=FAILED&lastRunStatus=SUCCESS"))).json.error as string,
    /^lastRunStatus was given 2 words/,
  );
});

test("the parameter being absent is the whole table, which is what it always meant", () => {
  for (const query of ["page=2", "isActive=true", "limit=100"]) {
    assert.equal(typeAsk(query).value, null);
    assert.equal(verdictAsk(query).value, null);
  }
});

test("SOURCE_TYPES and SOURCE_RUN_STATUSES are their schema comments", () => {
  assert.deepEqual([...SOURCE_TYPES], commented("Source", "type"), "the comment and the set are one list");
  assert.deepEqual(
    [...SOURCE_RUN_STATUSES],
    commented("Source", "lastRunStatus"),
    "PARTIAL is spelled by the comment; that is why it is declared",
  );
});

test("the code writes two of the three verdicts and the gap is a fact, not a mistake", () => {
  const written = [...new Set([...scraper.matchAll(/lastRunStatus:\s*"([A-Z]+)"/g)].map((found) => found[1]))].sort();
  assert.deepEqual(written, ["FAILED", "SUCCESS"], "scraper.ts stamps these two words");
  assert.deepEqual(
    written.filter((word) => !SOURCE_RUN_STATUSES.includes(word as (typeof SOURCE_RUN_STATUSES)[number])),
    [],
    "the worker is inventing a word the column does not document",
  );
  const unwritten = SOURCE_RUN_STATUSES.filter((word) => !written.includes(word));
  assert.deepEqual(
    [...unwritten],
    ["PARTIAL"],
    "if a run ever stamps PARTIAL, this pin is the place that sentence in enums.ts and the contract line have to be re-measured",
  );
});

test("nothing anywhere else writes the verdict column either", () => {
  const offenders = srcFiles("lib")
    .filter((file) => !file.endsWith("scraper.ts"))
    .map((file) => [file.slice(srcDir.length), blankComments(readFileSync(file, "utf8")).matchAll(/lastRunStatus:\s*"([A-Z]+)"/g)] as const)
    .filter(([, found]) => [...found].length > 0)
    .map(([file]) => file);
  assert.deepEqual(offenders, [], `a second writer of Source.lastRunStatus appeared: ${offenders.join(", ")}`);
});

test("GET /api/sources filters both words through the vocabulary", () => {
  const body = functionBody(blankComments(sourcesDoor), "GET_impl") ?? "";
  assert.match(body, /filterParam\(searchParams,\s*"type",\s*SOURCE_TYPES\)/);
  assert.match(body, /filterParam\(searchParams,\s*"lastRunStatus",\s*SOURCE_RUN_STATUSES\)/);
  assert.match(body, /if \(type\.error\) return type\.error/);
  assert.match(body, /if \(lastRunStatus\.error\) return lastRunStatus\.error/);
  assert.doesNotMatch(body, /searchParams\.get\("(type|lastRunStatus)"\)/, "the raw parameters are not read");
  assert.match(body, /where\.type = type\.value/);
  assert.match(body, /where\.lastRunStatus = lastRunStatus\.value/);
});

test("a word the door judges is a word the where only ever gets from the judge", () => {
  // The `where` is assembled from checked values, and `filterParam` returns `null` for both
  // an absent and a refused word, so the two `if` guards above are the only path a word has
  // into the query. Checked here rather than assumed, because a `where.type = type.value`
  // outside the guard would put `null` in the filter and answer an empty page for a caller
  // who asked for nothing.
  const body = functionBody(blankComments(sourcesDoor), "GET_impl") ?? "";
  for (const word of ["type", "lastRunStatus"]) {
    const assigns = [...body.matchAll(new RegExp(`where\\.${word}\\s*=`, "g"))];
    assert.equal(assigns.length, 1, `${word} is assigned to the where exactly once`);
    const at = body.indexOf(assigns[0][0]);
    assert.match(body.slice(Math.max(0, at - 60), at), new RegExp(`if \\(${word}\\.value\\)`), `${word} is guarded`);
  }
});

test("every parameter a read door documents is a parameter that door reads", () => {
  // The census that would have caught this round from the other side: eight presses of two
  // names the door answered by ignoring them. A door is not allowed to advertise — or, once
  // this round is in, to keep advertising — a query parameter it never looks at. A name
  // counts as read when the route's own text asks for it, either by that literal name or
  // through the helper that owns it (`pageParams` for the paging pair, `fieldsParam` for the
  // projection), because that is where the decision lives.
  const helperOwned: Record<string, RegExp> = { page: /pageParams\(/, limit: /pageParams\(/, fields: /fieldsParam\(/ };
  const judged = (code: string, name: string): boolean =>
    new RegExp(`searchParams\\.get\\("${name}"\\)`).test(code) ||
    new RegExp(`\\(\\s*searchParams,\\s*"${name}"`).test(code) ||
    (helperOwned[name] ?? /$^/).test(code);
  const offenders: string[] = [];
  for (const { operation, path } of openapiOperations) {
    const expected = `${srcDir}/app${path.replace(/\{([a-zA-Z]+)\}/g, "[$1]")}/route.ts`;
    const file = srcFiles("app/api").find((f) => f === expected);
    assert.ok(file, `${path} is served by ${expected.slice(srcDir.length)}, which the scan can read`);
    const code = blankComments(readFileSync(file, "utf8"));
    for (const [name] of operation.query ?? []) {
      if (!judged(code, name)) offenders.push(`${operation.id} documents \`${name}\` and never reads it`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});

test("the contract names both sets and prices a wrong word in each", () => {
  const door = openapiOperations.find((entry) => entry.operation.id === "sources.list");
  assert.ok(door, "sources.list is in the contract");
  const operation = door.operation;
  for (const [name, words] of [["type", SOURCE_TYPES], ["lastRunStatus", SOURCE_RUN_STATUSES]] as const) {
    const described = (operation.query ?? []).find(([param]) => param === name);
    assert.ok(described, `sources.list documents \`${name}\``);
    for (const word of words) {
      assert.ok(described[1].includes(word), `the \`${name}\` description lists ${word}`);
    }
    const priced = (operation.responses ?? {})["400"];
    assert.ok(priced && priced.includes(`\`${name}\``), `the 400 names \`${name}\` — "${priced}"`);
  }
  const verdict = (operation.query ?? []).find(([param]) => param === "lastRunStatus")![1];
  assert.match(verdict, /PARTIAL/, "and the description says what the unwritten word is for");
  assert.match(verdict, /empty page|no word/, "without hiding that no source can ever answer to it");
});
