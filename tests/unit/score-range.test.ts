// #60: one number, three grammars, and the busiest door had none. Measured on `origin/main`
// (65bd942) on the running app — `:3401` over `leadworks_r60`, Redis 6399, leads at score 0, 5,
// 49, 50, 51, 72, 90, 100, each put there through `PATCH /api/leads/{id} {"score":N}` —
// `/tmp/opencode/r60_measure_b.log`, `r60_measure_c.log`:
//
//   GET /api/leads?minScore=50        200 total=5   the honest one
//   GET /api/leads?minScore=101       200 total=1   [100] — a bound that cannot hold became a clamp
//   GET /api/leads?minScore=500       200 total=1   the same clamp
//   GET /api/leads?minScore=51.5      200 total=4   the fraction dropped, so 51 came back
//   GET /api/leads?minScore=1e2       200 total=7   asked for 100, `parseInt` read 1
//   GET /api/leads?minScore=0x32      200 total=8   asked for 50, got everybody
//   GET /api/leads?minScore=abc       200 total=8   a word became no filter
//   GET /api/leads?maxScore=1e2       200 total=1   [0] — asked for everything, got the worst lead
//   GET /api/leads?minScore=90&minScore=10  200 total=2   the second word dropped without a word
//   GET /api/leads?minScore=80&maxScore=20  200 total=0   a contradiction, answered as an empty crowd
//
// `POST /api/exports {"filterJson":{"minScore":101}}` was a 201 whose job then FAILED with
// `filterJson.minScore must be a whole number from 0 to 100` — as did `51.5`, `"50"` and `-1` —
// while `{"minScore":50,"maxScore":20}` was a 201 that COMPLETED with `records=0`: a delivered
// empty file for an impossible range. And `POST /api/enrichment-rules` refuses the same shape a
// third way (`score asks for at least 80 and at most 20 — no number is both`). The served
// contract listed `workspaceId, listId, status, page, limit, fields` for this door and contained
// zero strings matching a score bound.
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCORE_MAX, SCORE_MIN, scoreParam, scoreRangeProblem, wholeScoreProblem } from "../../src/lib/score-range";
import { readExportFilter } from "../../src/lib/export-format";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ask = (query: string) => new URLSearchParams(query);

/** The refusal's status and body, read once the way the door's caller reads it. */
async function refusal(output: { value: number | null; error: null | Response }) {
  assert.ok(output.error, "this helper is for the answer that refuses");
  const response = output.error as Response;
  return { status: response.status, json: (await response.json()) as { error: string } };
}

describe("the rule both doors speak", () => {
  it("is the column's own range, which the arithmetic cannot leave", () => {
    assert.equal(SCORE_MIN, 0);
    assert.equal(SCORE_MAX, 100);
  });

  it("accepts every whole number in it and nothing outside", () => {
    for (const value of [0, 5, 50, 100]) assert.equal(wholeScoreProblem("minScore", value), null, String(value));
    for (const value of [-1, 101, 500, 1.5, 60.5, -0.5, Number.NaN]) {
      assert.equal(wholeScoreProblem("minScore", value), "minScore must be a whole number from 0 to 100", String(value));
    }
  });

  it("refuses a number that arrived as text, because the reader only honours numbers", () => {
    // Measured on the base build: the export door stored `{"maxScore":"50"}` and the worker then
    // FAILED with this sentence. The exporter's `typeof … === "number"` means a stored string is
    // a silently wider file, so a body's number must be a number.
    assert.equal(wholeScoreProblem("filterJson.maxScore", "50"), "filterJson.maxScore must be a whole number from 0 to 100");
    assert.equal(wholeScoreProblem("minScore", 50), null);
  });

  it("refuses what is not a number at all", () => {
    for (const value of [null, undefined, {}, [], true, "50"]) {
      assert.equal(wholeScoreProblem("minScore", value), "minScore must be a whole number from 0 to 100", JSON.stringify(value));
    }
  });

  it("says the range, not a number the caller never sent", () => {
    // `intParam` was not a lie exactly — it was silent, which is worse: the answer carried no
    // trace of the bound it had substituted. The sentence names the legal set instead.
    assert.match(wholeScoreProblem("maxScore", 101)!, /^maxScore must be a whole number from 0 to 100$/);
  });
});

describe("scoreParam: a bound off the query string", () => {
  it("treats absent, empty and padding-only as no opinion", () => {
    for (const query of ["", "limit=10", "minScore=", "minScore=%20", "status=NEW"]) {
      const out = scoreParam(ask(query), "minScore");
      assert.equal(out.value, null, query);
      assert.equal(out.error, null, query);
    }
  });

  it("reads the eight measured whole numbers back as themselves", () => {
    for (const [word, want] of [["0", 0], ["5", 5], ["49", 49], ["50", 50], ["51", 51], ["72", 72], ["90", 90], ["100", 100]] as const) {
      assert.equal(scoreParam(ask(`minScore=${word}`), "minScore").value, want, word);
    }
  });

  it("trims: padding is not part of the number", () => {
    // The base door got this by accident through `parseInt`; here it is a decision with a pin.
    assert.equal(scoreParam(ask("maxScore=%2050"), "maxScore").value, 50);
    assert.equal(scoreParam(ask("maxScore=50%20"), "maxScore").value, 50);
    assert.equal(scoreParam(ask("maxScore=%0951%09"), "maxScore").value, 51);
  });

  it("refuses the seven measured spellings that are not a whole number in range", async () => {
    // Each of these was a `200` over a crowd the caller did not ask for.
    for (const word of ["101", "500", "51.5", "1e2", "0x32", "abc", "-5"]) {
      const out = scoreParam(ask(`minScore=${encodeURIComponent(word)}`), "minScore");
      const { status, json } = await refusal(out);
      assert.equal(status, 400, word);
      assert.equal(out.value, null, word);
      assert.equal(json.error, `minScore must be a whole number from 0 to 100, got "${word}"`, word);
    }
  });

  it("refuses a plus-less-minus that is only a sign", async () => {
    // `-0` is 0, and `+50` is 50: the sign is part of a whole number, not a separate vocabulary.
    assert.equal(scoreParam(ask("minScore=%2B50"), "minScore").value, 50);
    assert.equal(scoreParam(ask("minScore=-0"), "minScore").value, 0);
  });

  it("counts the same number twice as the one number it is", () => {
    const out = scoreParam(new URLSearchParams([["minScore", " 90 "], ["minScore", "90"]]), "minScore");
    assert.equal(out.value, 90);
    assert.equal(out.error, null);
  });

  it("refuses two numbers rather than quietly answering one of them", async () => {
    // Base: `?minScore=90&minScore=10` was `[100,90]` — the first word's crowd, the second dropped.
    const out = scoreParam(new URLSearchParams([["minScore", "90"], ["minScore", "10"]]), "minScore");
    const { status, json } = await refusal(out);
    assert.equal(status, 400);
    assert.equal(
      json.error,
      "minScore was given 2 numbers (\"90\", \"10\"); this filter compares minScore to one of them",
    );
  });

  it("prices the word it refused inside its own sentence, so the caller can see what landed", async () => {
    const { json } = await refusal(scoreParam(ask("maxScore=1e2"), "maxScore"));
    assert.equal(json.error, "maxScore must be a whole number from 0 to 100, got \"1e2\"");
  });
});

describe("a floor above a ceiling is a mistake in the question", () => {
  it("names both numbers instead of answering with nobody", () => {
    assert.equal(
      scoreRangeProblem(80, 20),
      "minScore 80 is above maxScore 20, and no score is both — this range describes no lead rather than an empty crowd",
    );
  });

  it("leaves a range that holds something alone", () => {
    assert.equal(scoreRangeProblem(50, 90), null);
    assert.equal(scoreRangeProblem(49, 51), null);
    assert.equal(scoreRangeProblem(100, 100), null, "one lead at exactly 100 is a real crowd");
    assert.equal(scoreRangeProblem(0, 0), null);
  });

  it("is the same judgement the stored rule door already makes", () => {
    // `rule-conditions.ts` refuses `{"gte":80,"lte":20}` for an enrichment rule; the read door
    // said `total=0`. Two answers for one question, now one.
    const conditions = at("../../src/lib/rule-conditions.ts");
    assert.match(conditions, /no number is both/);
    assert.match(scoreRangeProblem(80, 20)!, /no score is both/);
  });
});

describe("the doors say it together", () => {
  it("the stored filter's sentence is this module's, byte for byte", () => {
    for (const value of [101, 51.5, "50", -1]) {
      assert.throws(() => readExportFilter({ minScore: value }), {
        message: "filterJson.minScore must be a whole number from 0 to 100",
      }, JSON.stringify(value));
    }
    assert.deepEqual(readExportFilter({ minScore: 50, maxScore: 90 }), { minScore: 50, maxScore: 90 });
  });

  it("and the read door calls the parse for both bounds, and the range for the pair", () => {
    const route = at("../../src/app/api/leads/route.ts");
    assert.match(route, /scoreParam\(searchParams, "minScore"\)/);
    assert.match(route, /scoreParam\(searchParams, "maxScore"\)/);
    assert.match(route, /scoreRangeProblem\(minScore\.value, maxScore\.value\)/);
    assert.match(route, /if \(minScore\.error\) return minScore\.error;/, "a refusal returns before the query");
    assert.match(route, /if \(maxScore\.error\) return maxScore\.error;/);
    assert.match(route, /where\.score = \{ \.\.\.where\.score, gte: minScore\.value \}/);
    assert.match(route, /where\.score = \{ \.\.\.where\.score, lte: maxScore\.value \}/);
    assert.equal(route.includes('intParam(searchParams, "minScore"'), false);
    assert.match(route, /export const dynamic = "force-dynamic"/);
  });

  it("the census: every file that speaks a score bound either asks the rule or only obeys it", () => {
    // Measured set on `main`: leads/route.ts (the query), export-format.ts (the stored filter),
    // exporter.ts (applies what the filter stored), lead-score.ts (the arithmetic that makes the
    // column 0-100), openapi.ts (the prose). Anything else naming a bound is a third grammar;
    // anything using `intParam` on one is the silent fallback this round removed.
    const speaks = ["../../src/app/api/leads/route.ts", "../../src/lib/export-format.ts", "../../src/lib/score-range.ts"];
    const obeys = ["../../src/lib/exporter.ts", "../../src/lib/openapi.ts"];
    const offside: string[] = [];
    for (const file of walk("../../src/")) {
      const code = blankCommentsOf(at(file));
      if (!/minScore|maxScore/.test(code)) continue;
      if (speaks.includes(file)) {
        if (!code.includes("scoreParam") && !code.includes("wholeScoreProblem")) offside.push(`${file}: names a bound without the rule`);
        continue;
      }
      if (obeys.includes(file)) {
        if (/intParam\(searchParams, "(minScore|maxScore)"/.test(code)) offside.push(`${file}: fell back to intParam`);
        if (/if \((minScore|maxScore) (>|<)/.test(code)) offside.push(`${file}: decides a bound's truth itself`);
        continue;
      }
      offside.push(`${file}: a new place that speaks a score bound`);
    }
    assert.deepEqual(offside, [], "no third place decides a score bound its own way");
    assert.equal(at("../../src/app/api/leads/route.ts").includes('intParam(searchParams, "minScore"'), false);
  });
});

describe("the contract found out", () => {
  const operation = openapiOperations.find((op) => op.operation.id === "leads.list")!;
  const query = (operation.operation.query as [string, string][]) ?? [];

  it("advertises both bounds, which it did not advertise at all", () => {
    const names = query.map(([name]) => name);
    assert.ok(names.includes("minScore"), "minScore is in the contract now");
    assert.ok(names.includes("maxScore"), "and so is maxScore");
  });

  it("says the range in the same words the door refuses with", () => {
    for (const name of ["minScore", "maxScore"]) {
      const line = query.find(([one]) => one === name)![1];
      assert.match(line, /whole number from 0 to 100/);
    }
  });

  it("prices the 400 for each way a bound can be wrong", () => {
    const responses = operation.operation.responses as Record<string, string>;
    assert.match(responses["400"], /a `minScore` or `maxScore` that is not a whole number from 0 to 100/);
    assert.match(responses["400"], /two numbers at once/);
    assert.match(responses["400"], /a `minScore` above the `maxScore`/);
  });

  it("and only this door filters by a score bound off a query string", () => {
    const withBounds = openapiOperations
      .filter((op) => ((op.operation.query as [string, string][]) ?? []).some(([name]) => name === "minScore" || name === "maxScore"))
      .map((op) => op.operation.id as string);
    assert.deepEqual(withBounds, ["leads.list"]);
  });
});

function blankCommentsOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const here = `${dir}${entry.name}`;
    if (entry.isDirectory()) walk(`${here}/`, into);
    else if (here.endsWith(".ts")) into.push(here);
  }
  return into;
}
