// #56 — the filters that answer an empty page.
//
// Measured on the running app before any of this shipped, in this round's own
// runtime (`:3361` over database `leadworks_r56`, logs `/tmp/opencode/r56_measure*.log`):
// six leads seeded one per `Lead.status` word, the five job types queued through
// `POST /api/jobs`, and CSV exports created through `POST /api/exports` — so the
// Export column held COMPLETED and FAILED rows and no PENDING or PROCESSING one.
// The base table, verbatim:
//
//   GET /api/leads?status=NEW                    200 total=1
//   GET /api/leads?status=new                    200 total=0   — no refusal, an empty page
//   GET /api/leads?status=NEW%20                 200 total=0   — the padding became the word
//   GET /api/leads?status=NEW,ENRICHED           200 total=0   — a comma is not an OR
//   GET /api/leads?status=ACTIVE                 200 total=0   — a word no column holds
//   GET /api/leads?status=PROCESSING             200 total=0   — an Export word, asked of a Lead
//   GET /api/leads?status=null                   200 total=0
//   GET /api/leads?status=NEW&status=ENRICHED    200 total=1   — one of the two, silently
//   GET /api/jobs?type=scrape                    200 total=0   (type=SCRAPE: total=1)
//   GET /api/jobs?status=DONE                    200 total=0   — the value PATCH refuses by name
//   GET /api/exports?status=RUNNING              200 total=0   — a Job word, asked of an Export
//   GET /api/exports?status=PROCESSING           200 total=0   — a real Export word, declared nowhere
//   POST /api/exports {"filterJson":{"status":"ACTIVE"}}       201, then COMPLETED records=0 bytes=0
//   POST /api/exports {"filterJson":{"status":"qualified"}}    201, then COMPLETED records=0 bytes=0
//
// A mistyped filter and a crowd that really is empty were the same answer, at
// four doors, in five parameters — while the same three doors refuse a wrong
// `?fields=` name, a wrong `sourceId` and a wrong body word by naming the whole
// set, and the same word written into a rule's or a list's filter is refused the
// way only a write door can: `PATCH /api/leads/{id} {status:"DONE"}` was already
//
//   400 status must be one of NEW | ENRICHED | QUALIFIED | CONTACTED | CONVERTED | REJECTED, got "DONE"
//
// so this file pins the read doors saying that sentence too, the vocabulary
// `EXPORT_STATUSES` transcribed from the schema comment it came out of, and the
// census that keeps a fifth door from opening the same hole.
//
// Nothing here needs a browser, a database or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import { EXPORT_STATUSES, JOB_STATUSES, JOB_TYPES, LEAD_STATUSES } from "../../src/lib/enums";
import { filterParam, filterWordProblem } from "../../src/lib/list-filter";
import { openapiOperations } from "../../src/lib/openapi";
import { readExportFilter } from "../../src/lib/export-format";

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
const leadsDoor = at("../../src/app/api/leads/route.ts");
const jobsDoor = at("../../src/app/api/jobs/route.ts");
const exportsDoor = at("../../src/app/api/exports/route.ts");
const exporter = blankComments(at("../../src/lib/exporter.ts"));
const exportFormat = blankComments(at("../../src/lib/export-format.ts"));

/** The words one column's schema comment shows, in the order the file writes them. */
function commented(model: string, column: string): string[] {
  // The model's own block, to the `}` that closes it — `Lead` carries a
  // `PATCH /api/leads/{id}` in a comment, so a brace is not where the block ends.
  const block = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
  const found = new RegExp(`^\\s+${column}\\s+\\S+[^/]*// (.*)$`, "m").exec(block);
  assert.ok(found, `${model}.${column} has no comment set in prisma/schema.prisma to compare against`);
  return (found?.[1] ?? "").split("|").map((word) => word.trim());
}

/** Ask one door's filter the way the route does. */
const asked = (query: string, words: readonly string[]) =>
  filterParam(new URLSearchParams(query), "status", words);

const message = (result: ReturnType<typeof filterParam>) => {
  assert.ok(result.error, "the filter was expected to refuse");
  return result.error;
};

/** The 400's own body, read the way the door's caller would read it. */
async function refusal(result: ReturnType<typeof filterParam>) {
  const error = message(result);
  return { status: error.status, json: (await error.json()) as Record<string, unknown> };
}

test("every word the column holds is a word the filter takes", () => {
  for (const word of LEAD_STATUSES) {
    const result = asked(`status=${word}`, LEAD_STATUSES);
    assert.equal(result.value, word, `?status=${word} filters for ${word}`);
    assert.equal(result.error, null);
  }
});

test("a word outside the set is refused in the sentence the write door uses", async () => {
  for (const word of ["ACTIVE", "DONE", "PROCESSING", "RUNNING", "null", "NEW,ENRICHED"]) {
    const result = asked(`status=${word}`, LEAD_STATUSES);
    assert.equal(result.value, null, `${word} never reaches the where`);
    assert.equal(
      (await refusal(result)).json.error,
      `status must be one of ${LEAD_STATUSES.join(" | ")}, got "${word}"`,
      "one sentence for one column, at the door that writes it and the door that reads it",
    );
  }
});

test("a column is not its own capitalisation", async () => {
  // `?fields=Email` is refused at the same door for the same reason: the word is
  // the one the column holds, and a filter that quietly upper-cased it would be a
  // filter that quietly decided something the caller did not ask.
  for (const word of ["new", "New", "nEw"]) {
    assert.match((await refusal(asked(`status=${word}`, LEAD_STATUSES))).json.error as string, new RegExp(`got "${word}"`));
  }
  assert.equal(asked("status=NEW", LEAD_STATUSES).value, "NEW");
});

test("the padding is not part of the word", () => {
  for (const query of ["status=%20NEW", "status=NEW%20", "status=%20NEW%20", "status=%09NEW%09"]) {
    assert.equal(asked(query, LEAD_STATUSES).value, "NEW", `${query} is NEW`);
    assert.equal(asked(query, LEAD_STATUSES).error, null);
  }
});

test("an empty value names nothing about the column", () => {
  for (const query of ["status=", "status=%20", "status=%09"]) {
    const result = asked(query, LEAD_STATUSES);
    assert.equal(result.value, null, `${query} is an absent status, not a wrong one`);
    assert.equal(result.error, null);
  }
});

test("the parameter being absent is the same answer as naming nothing", () => {
  const result = asked("page=2", LEAD_STATUSES);
  assert.equal(result.value, null);
  assert.equal(result.error, null);
});

test("the same word twice is one word", () => {
  const result = asked("status=NEW&status=NEW&status=%20NEW", LEAD_STATUSES);
  assert.equal(result.value, "NEW");
  assert.equal(result.error, null);
});

test("two different words are a refusal that names both and counts them", async () => {
  const two = await refusal(asked("status=NEW&status=ENRICHED", LEAD_STATUSES));
  assert.equal(
    two.json.error,
    'status was given 2 words ("NEW", "ENRICHED"); this filter compares status to one of them',
  );
  const three = await refusal(asked("status=NEW&status=ENRICHED&status=QUALIFIED", LEAD_STATUSES));
  assert.match(three.json.error as string, /^status was given 3 words \("NEW", "ENRICHED", "QUALIFIED"\)/);
});

test("a word paired with an empty one is still the one word", () => {
  assert.equal(asked("status=NEW&status=", LEAD_STATUSES).value, "NEW");
});

test("a refusal is a 400 carrying the message and nothing else", async () => {
  const { status, json } = await refusal(asked("status=ACTIVE", LEAD_STATUSES));
  assert.equal(status, 400);
  assert.deepEqual(Object.keys(json), ["error"]);
});

test("the pure judge says the same thing with a longer name", () => {
  assert.equal(filterWordProblem("filterJson.status", "QUALIFIED", LEAD_STATUSES), null);
  assert.equal(
    filterWordProblem("filterJson.status", "ACTIVE", LEAD_STATUSES),
    `filterJson.status must be one of ${LEAD_STATUSES.join(" | ")}, got "ACTIVE"`,
  );
});

test("EXPORT_STATUSES is the schema comment, and nothing else", () => {
  assert.deepEqual([...EXPORT_STATUSES], commented("Export", "status"), "the comment and the set are one list");
  assert.deepEqual(
    [...EXPORT_STATUSES],
    ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
    "PROCESSING is the word a reader could not name before #56",
  );
});

test("the other three sets the read doors filter by are their schema comments too", () => {
  assert.deepEqual([...LEAD_STATUSES], commented("Lead", "status"));
  assert.deepEqual([...JOB_STATUSES], commented("Job", "status"));
  assert.deepEqual([...JOB_TYPES], commented("Job", "type"));
});

test("every status the export code writes is a word the door will take", () => {
  const written = [...exporter.matchAll(/status:\s*"([A-Z]+)"/g)].map((found) => found[1]);
  assert.ok(written.length >= 3, `the exporter writes the status column (${written.length} places found)`);
  assert.deepEqual(
    [...new Set(written)].filter((word) => !EXPORT_STATUSES.includes(word as (typeof EXPORT_STATUSES)[number])),
    [],
    `the worker is inventing a fifth word: ${written.join(", ")}`,
  );
  assert.ok(written.includes("PROCESSING"), "PROCESSING is written, which is why it is declared");
});

test("GET /api/leads filters status through the vocabulary", () => {
  const body = functionBody(blankComments(leadsDoor), "GET_impl") ?? "";
  assert.match(body, /filterParam\(searchParams,\s*"status",\s*LEAD_STATUSES\)/);
  assert.match(body, /if \(status\.error\) return status\.error/);
  assert.doesNotMatch(body, /searchParams\.get\("status"\)/, "the raw parameter is not read any more");
  assert.match(body, /where\.status = status\.value/, "and what reaches Prisma is the checked word");
});

test("GET /api/jobs filters both of its words", () => {
  const body = functionBody(blankComments(jobsDoor), "GET_impl") ?? "";
  assert.match(body, /filterParam\(searchParams,\s*"type",\s*JOB_TYPES\)/);
  assert.match(body, /filterParam\(searchParams,\s*"status",\s*JOB_STATUSES\)/);
  assert.doesNotMatch(body, /searchParams\.get\("(type|status)"\)/);
  assert.match(body, /where\.type = type\.value/);
  assert.match(body, /where\.status = status\.value/);
});

test("GET /api/exports filters status by the Export set, not the Job one", () => {
  const body = functionBody(blankComments(exportsDoor), "GET_impl") ?? "";
  assert.match(body, /filterParam\(searchParams,\s*"status",\s*EXPORT_STATUSES\)/);
  assert.doesNotMatch(body, /searchParams\.get\("status"\)/);
  assert.doesNotMatch(body, /JOB_STATUSES/, "RUNNING is not an Export word and is not accepted as one");
});

test("no read door anywhere takes a status or type word straight from the query string", () => {
  // The census is the point: a fifth door that reads `searchParams.get("status")`
  // and hands it to Prisma re-opens this round from the other end. Every route
  // file is scanned, not just the three that were measured — a door added next
  // month is exactly what a per-file assertion would miss.
  const offenders: string[] = [];
  for (const file of srcFiles("app/api")) {
    const code = blankComments(readFileSync(file, "utf8"));
    for (const column of ["status", "type"]) {
      if (new RegExp(`searchParams\\.get\\("${column}"\\)`).test(code)) {
        offenders.push(`${file.slice(srcDir.length)} — reads ${column} raw`);
      }
    }
  }
  assert.deepEqual(offenders, [], `query-string filters with no vocabulary in front of them:\n  ${offenders.join("\n  ")}`);
});

test("an export's stored filter is refused the word the worker could never match", () => {
  assert.deepEqual(readExportFilter({ status: "QUALIFIED" }), { status: "QUALIFIED" });
  assert.deepEqual(readExportFilter(undefined), {});
  assert.deepEqual(readExportFilter(null), {});
  assert.throws(
    () => readExportFilter({ status: "ACTIVE" }),
    /^Error: filterJson\.status must be one of NEW \| ENRICHED \| QUALIFIED \| CONTACTED \| CONVERTED \| REJECTED, got "ACTIVE"$/,
    "the sentence, with the place the word arrived named",
  );
  assert.throws(() => readExportFilter({ status: "qualified" }), /must be one of/, "a fold is not a fix");
});

test("POST /api/exports asks the worker's question before it writes a row", () => {
  // Retargeted in #68, not relaxed: the door used to call `exportFilterProblem`,
  // which judged the blob and threw the judgement away. It now reads through
  // `exportFilter` so the filter it files is the one it judged — and the padded name
  // it refused-to-resolved never reaches a stored row. Both halves of what this test
  // always asked still hold: the judge is called, and it runs before anything is
  // written.
  const body = functionBody(blankComments(exportsDoor), "POST_impl") ?? "";
  assert.match(body, /exportFilter\(input\.data\.filterJson\)/);
  assert.doesNotMatch(body, /exportFilterProblem/, "the door keeps the value, so it does not ask for the sentence alone");
  assert.ok(
    body.indexOf("exportFilter") < body.indexOf("prisma.export.create"),
    "the refusal happens before anything is stored",
  );
  assert.match(exportFormat, /filterWordProblem\("filterJson\.status",\s*status,\s*LEAD_STATUSES\)/);
});

test("the contract names the set each filter judges against, and prices a wrong word", () => {
  // A door that refuses in the source while advertising only a 200 is a door an
  // integrator meets with one wrong word and no idea why it came back empty.
  // The descriptions are built from the same arrays the routes check with, so
  // this pins both halves: that the set is spelled out, and that it is spelled
  // out from the source of truth rather than re-typed into the spec.
  const spec = openapiOperations;
  const door = (id: string) => {
    const found = spec.find((entry) => entry.operation.id === id);
    assert.ok(found, `${id} is in the contract`);
    return found!;
  };
  const doors: [string, string, readonly string[]][] = [
    ["leads.list", "status", LEAD_STATUSES],
    ["jobs.list", "type", JOB_TYPES],
    ["jobs.list", "status", JOB_STATUSES],
    ["exports.list", "status", EXPORT_STATUSES],
  ];
  for (const [id, name, words] of doors) {
    const operation = door(id).operation;
    const described = (operation.query ?? []).find(([param]) => param === name);
    assert.ok(described, `${id} documents \`${name}\``);
    for (const word of words) {
      assert.ok(described[1].includes(word), `the ${id} \`${name}\` description lists ${word}`);
    }
    const refusal = (operation.responses ?? {})["400"];
    assert.ok(refusal, `${id} says what a wrong ${name} costs`);
    assert.ok(refusal.includes(`\`${name}\``), `${id}'s 400 names \`${name}\` — "${refusal}"`);
  }

  const create = door("exports.create").operation;
  const filter = create.body!.properties.filterJson!.description;
  for (const word of LEAD_STATUSES) {
    assert.ok(filter.includes(word), "the stored filter is described with the Lead words it takes");
  }
  assert.ok((create.responses ?? {})["400"], "and the export door's own refusal is priced");
});
