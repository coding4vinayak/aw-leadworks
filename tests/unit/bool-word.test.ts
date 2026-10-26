// #57: two read doors filtered a `Boolean` column by comparing the caller's word
// to one literal, and the contract told integrators to send a digit. Measured on
// `origin/main` at 65bd942 built in this round's worktree, served on :3371 over
// `leadworks_r57` with a private Redis on 6396, over three active sources and two
// paused ones plus two active rules and one paused one:
//
//   GET /api/openapi     "isActive :: Only the ones running (1) or paused (0)."
//   GET /api/sources                    200 total=5   — everything
//   GET /api/sources?isActive=true      200 total=3   [src-active-1..3]
//   GET /api/sources?isActive=false     200 total=2   [src-paused-1..2]
//   GET /api/sources?isActive=1         200 total=2   [src-paused-1..2]  ← "running", per the contract
//   GET /api/sources?isActive=0         200 total=2   [src-paused-1..2]
//   GET /api/sources?isActive=TRUE      200 total=2   [src-paused-1..2]
//   GET /api/sources?isActive=yes       200 total=2   [src-paused-1..2]
//   GET /api/sources?isActive=%20true   200 total=2   [src-paused-1..2]
//   GET /api/sources?isActive=          200 total=2   [src-paused-1..2]  — "no opinion" became "paused"
//   GET /api/sources?isActive=true&isActive=false
//                                       200 total=3   — the first word, silently
//   GET /api/enrichment-rules?isActive=1 200 total=1  [rule-paused-1]
//   PATCH /api/sources/{id} {"isActive":"1"} 400 isActive must be true or false, got a string — send it unquoted
//
// So `1` and `0` — the only two values the published sentence names — were the
// same page, and it was the page of rows `scheduler.ts:76`, `scheduler.ts:106`,
// `scheduler.ts:147` and `enrichment.ts:349` skip, because those sweep
// `isActive: true`. The word for "running" was refused by the write door and
// answered with "paused" by the read door. `/tmp/opencode/r57_measure.log` and
// `r57_measure_c.log` hold the run.
//
// Nothing here needs a browser, a database or a network.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOOL_WORDS, boolParam, boolWordProblem } from "../../src/lib/bool-word";
import { RULE_CREATE, SOURCE_CREATE, SOURCE_PATCH } from "../../src/lib/fields";
import { validateBody } from "../../src/lib/validate";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ask = (query: string) => boolParam(new URLSearchParams(query), "isActive");
const SRC_ROOT = join(process.cwd(), "src");

/** Every word this round measured a caller could send, other than the two legal ones. */
const WRONG = ["1", "0", "TRUE", "True", "tRuE", "yes", "no", "on", "off", "y", "n", "t", "f", "01", "true1", "null", "garbage", '"true"'];

async function body(error: NonNullable<ReturnType<typeof ask>["error"]>) {
  return (await error.json()) as Record<string, string>;
}

/** The 400 a body validator returns, read the way the door's caller would read it. */
async function refusal(input: { ok: boolean; error?: undefined | { status: number; json(): Promise<unknown> } }) {
  assert.equal(input.ok, false, "this helper is for the answer that refuses");
  const error = input.error as { status: number; json(): Promise<Record<string, unknown>> };
  return { status: error.status, json: await error.json() };
}

/** The hand-written shape `egress-sites.test.ts` walks for the same reason. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "generated") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("BOOL_WORDS: two words, and the module says so", () => {
  it("holds exactly true and false", () => {
    assert.deepEqual([...BOOL_WORDS], ["true", "false"]);
  });

  it("accepts both of its own words and nothing else in the measured list", () => {
    for (const word of BOOL_WORDS) assert.equal(boolWordProblem("isActive", word), null, word);
    for (const word of WRONG) {
      const problem = boolWordProblem("isActive", word);
      assert.ok(problem !== null, `${word} is not a boolean word`);
      assert.ok(problem.includes(`got "${word}"`), `${word} is echoed back: ${problem}`);
    }
  });

  it("names the whole set in the sentence, so a caller can fix the word without guessing", () => {
    assert.equal(boolWordProblem("isActive", "1"), `isActive must be one of ${BOOL_WORDS.join(" | ")}, got "1"`);
  });

  it("leads with the column's own name, because two doors ask about two things", () => {
    assert.ok(boolWordProblem("enabled", "2")!.startsWith("enabled must be one of true | false, got "), "the name the caller used leads");
  });
});

describe("boolParam: not asking, asking for nothing, asking twice", () => {
  it("says no opinion when the request never mentioned the parameter", () => {
    for (const query of ["", "?limit=10", "?workspaceId=ws_x", "?active=true"]) {
      const asked = ask(query);
      assert.equal(asked.value, null, query);
      assert.equal(asked.error, null, query);
    }
  });

  it("takes each legal word for the state it names", () => {
    assert.equal(ask("isActive=true").value, true);
    assert.equal(ask("isActive=false").value, false);
  });

  it("treats padding as padding, not as part of the word", () => {
    for (const query of ["isActive=%20true", "isActive=true%20", "isActive=%09true", "isActive=%20true%20"]) {
      const asked = ask(query);
      assert.equal(asked.error, null, `${query} -> ${JSON.stringify(asked.value)}`);
      assert.equal(asked.value, true, query);
    }
  });

  it("treats an empty value as no opinion, the way an absent one is", () => {
    // `isActive=` used to answer the paused crowd. A form whose select has
    // nothing chosen sends exactly this, and the column's own `@default` is
    // true, so "no opinion" and "paused" are different questions.
    const empty = ask("isActive=");
    assert.equal(empty.value, null);
    assert.equal(empty.error, null);
    assert.deepEqual(ask("isActive=&isActive="), empty, "twice and still no opinion");
    assert.equal(ask("isActive=%20").value, null, "padding alone names nothing");
  });

  it("counts a word repeated as the one word it is", () => {
    assert.equal(ask("isActive=true&isActive=true").value, true);
    assert.equal(ask("isActive=false&isActive=false").value, false);
    assert.equal(ask("isActive=%20true&isActive=true%20").value, true, "padded and plain are one word");
  });

  it("refuses two different words instead of picking one", async () => {
    const asked = ask("isActive=true&isActive=false");
    assert.equal(asked.value, null);
    assert.equal(asked.error!.status, 400);
    const two = await body(asked.error!);
    assert.deepEqual(Object.keys(two), ["error"]);
    assert.equal(
      two.error,
      'isActive was given 2 words ("true", "false"); this filter compares isActive to one of them',
    );
    const three = await body(ask("isActive=true&isActive=false&isActive=1")!.error!);
    assert.ok(three.error.includes("3 words"), three.error);
  });

  it("refuses every word it used to answer with the paused crowd", async () => {
    for (const word of WRONG) {
      const asked = ask(`isActive=${encodeURIComponent(word)}`);
      assert.equal(asked.value, null, word);
      assert.equal(asked.error!.status, 400, `${word} was answered ${asked.error!.status}`);
      assert.equal((await body(asked.error!)).error, boolWordProblem("isActive", word), word);
    }
  });

  it("refuses the two digits the contract used to recommend, by naming them", async () => {
    for (const digit of ["1", "0"]) {
      const asked = ask(`isActive=${digit}`);
      assert.equal((await body(asked.error!)).error, `isActive must be one of true | false, got "${digit}"`);
    }
  });
});

describe("the refusal is shaped like the other read-door refusals", () => {
  it("is a 400 carrying one key, error", async () => {
    const error = ask("isActive=TRUE").error!;
    assert.equal(error.status, 400);
    assert.equal(error.headers.get("content-type"), "application/json");
    assert.deepEqual(Object.keys(await body(error)), ["error"]);
  });

  it("keeps a real filter for the paused crowd distinguishable from a wrong word", () => {
    // #56's finding, arriving from the coercion side: a mistyped filter and a
    // crowd that really is empty were the same answer. Refusing one of them is
    // the whole fix, so `false` has to stay a filter and `no` has to stop being
    // one.
    assert.equal(ask("isActive=false").value, false);
    assert.equal(ask("isActive=no").value, null);
    assert.ok(ask("isActive=no").error !== null, "the wrong word is a refusal, not the paused crowd");
  });
});

describe("one column, one vocabulary: the write door refuses what the read door refuses", () => {
  it("keeps a query word out of the JSON body at every door that writes the column", async () => {
    for (const schema of [SOURCE_CREATE, SOURCE_PATCH, RULE_CREATE]) {
      for (const word of ["1", "0", "yes", "true"]) {
        const input = validateBody({ name: "x", isActive: word }, schema);
        assert.equal(input.ok, false, `${word} as a string is not a boolean body field`);
        const { status, json } = await refusal(input);
        assert.equal(status, 400, word);
        assert.ok(JSON.stringify(json).includes("isActive must be true or false"), JSON.stringify(json));
      }
    }
  });

  it("accepts the same two words as JSON booleans, unquoted", () => {
    for (const value of [true, false]) {
      const input = validateBody({ name: "x", isActive: value }, SOURCE_PATCH);
      assert.ok(input.ok);
      if (input.ok) assert.equal(input.data.isActive, value);
    }
  });

  it("says it in each door's own tense and never in a third vocabulary", () => {
    // Body: `must be true or false … send it unquoted` (a JSON value is wanted).
    // Query: `must be one of true | false, got "1"` (a word is wanted). Both
    // name the same two states, which is the point of the round.
    const query = boolWordProblem("isActive", "1")!;
    assert.ok(query.includes("must be one of true | false"), query);
    assert.ok(query.includes(BOOL_WORDS.join(" | ")), "and the set the sentence prints is the set the module holds");
  });
});

describe("the doors ask the module instead of comparing to one literal", () => {
  const sources = at("../../src/app/api/sources/route.ts");
  const rules = at("../../src/app/api/enrichment-rules/route.ts");

  it("leaves no caller's word for a boolean judged by equality anywhere in src/", () => {
    const sites = sourceFiles(SRC_ROOT).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /(?:===|!==|==)\s*["'](true|false)["']/.test(text) && !file.endsWith(join("lib", "bool-word.ts"));
    });
    assert.deepEqual(
      sites.map((file) => relative(process.cwd(), file)),
      [],
      "the two doors were the last places comparing a request word to one literal",
    );
  });

  it("calls boolParam for isActive in both doors, once each", () => {
    for (const [name, file] of [["sources", sources], ["enrichment-rules", rules]] as const) {
      assert.equal(file.split("boolParam(").length - 1, 1, `${name} asks the module exactly once`);
      assert.ok(file.includes('boolParam(searchParams, "isActive")'), `${name} asks it about isActive`);
      assert.ok(/if \(active\.error\) return active\.error;/.test(file), `${name} returns the refusal`);
      assert.ok(file.includes("if (active.value !== null) where.isActive = active.value;"), `${name} filters by the judged word`);
      assert.ok(!file.includes('=== "true"') && !file.includes('!== "true"'), `${name} kept no half of the coercion`);
    }
  });

  it("judges the word before the crowd is asked", () => {
    for (const [name, file] of [["sources", sources], ["enrichment-rules", rules]] as const) {
      assert.ok(file.indexOf("boolParam(") < file.indexOf("prisma.source.findMany") || file.indexOf("boolParam(") < file.indexOf("prisma.enrichmentRule.findMany"),
        `${name} refuses without a query`);
    }
  });

  it("keeps the judgement in a module that touches no database, no wire and no clock", () => {
    const reading = at("../../src/lib/bool-word.ts");
    assert.ok(!reading.includes("prisma."), "no database");
    assert.ok(!reading.includes("fetch("), "no network");
    assert.ok(!reading.includes("Date.now("), "no clock");
  });
});

describe("the contract says what the doors do", () => {
  const door = (id: string) => {
    const found = openapiOperations.find((entry) => entry.operation.id === id);
    assert.ok(found, `${id} is in the contract`);
    return found!.operation;
  };

  for (const id of ["sources.list", "rules.list"]) {
    it(`names both words for ${id}, and prices a wrong one`, () => {
      const operation = door(id);
      const parameter = (operation.query ?? []).find(([name]) => name === "isActive");
      assert.ok(parameter, `${id} documents isActive`);
      const described = parameter[1];
      for (const word of BOOL_WORDS) {
        assert.ok(described.includes(word), `${id}: "${word}" is in the sentence — ${described}`);
      }
      assert.ok(!/\((1|0)\)/.test(described), `${id} no longer recommends a digit: ${described}`);
      const refusal = (operation.responses ?? {})["400"];
      assert.ok(refusal, `${id} prices a wrong word`);
      assert.ok(refusal.includes("`isActive`"), refusal);
    });
  }

  it("lists isActive as a query parameter at exactly these two doors", () => {
    const withIsActive = openapiOperations
      .filter((entry) => (entry.operation.query ?? []).some(([name]) => name === "isActive"))
      .map((entry) => entry.operation.id);
    assert.deepEqual(withIsActive, ["sources.list", "rules.list"], "the census: two boolean filters, no third door");
  });

  it("hands the emitted spec the same two sentences the table holds", () => {
    const spec = JSON.parse(JSON.stringify(openapiOperations.map((entry) => entry.operation)));
    for (const id of ["sources.list", "rules.list"]) {
      const operation = spec.find((entry: { id: string }) => entry.id === id);
      const isActive = operation.query.find(([name]: string[]) => name === "isActive")[1] as string;
      assert.ok(isActive.includes("true | false"), `${id}: ${isActive}`);
    }
  });
});
