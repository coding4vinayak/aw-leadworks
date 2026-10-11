// N1: the list routes used to hand the query string straight to Prisma, so
// `page=0` became a negative `skip` and `page=abc` became NaN — both throw,
// which is a 500 for a mistyped URL — while `limit=999999999` was the
// full-table read pagination exists to prevent. Same helper in every app of the
// family, because the apps are standalone.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { intParam, pageParams } from "../../src/lib/pagination";

const params = (query: Record<string, string>) => new URLSearchParams(query);

describe("page and limit are bounded by the server", () => {
  it("defaults to the first page at the route's own page size", () => {
    assert.deepEqual(pageParams(new URLSearchParams(""), 20), { page: 1, limit: 20 });
  });

  it("honours a sane page and limit", () => {
    assert.deepEqual(pageParams(params({ page: "3", limit: "10" }), 20), { page: 3, limit: 10 });
  });

  it("refuses to ask for the whole table", () => {
    assert.equal(pageParams(params({ limit: "999999999" }), 20).limit, 100);
    assert.equal(pageParams(params({ limit: "999999999" }), 50, 500).limit, 500);
  });

  it("treats a zero or negative page as the first page, not as a negative skip", () => {
    for (const page of ["0", "-4"]) assert.equal(pageParams(params({ page }), 20).page, 1, page);
  });

  it("treats a non-numeric or zero limit as the default, never as NaN or take:0", () => {
    for (const limit of ["abc", "", "0", "-1", "  "]) {
      assert.equal(pageParams(params({ limit }), 20).limit, 20, JSON.stringify(limit));
    }
  });
});

describe("score filters are numbers, not NaN", () => {
  it("keeps the documented range, so a typo cannot widen or empty the result", () => {
    const dflt = (name: string, v: string) => intParam(params({ [name]: v }), name, 0, 0, 100);
    assert.equal(dflt("minScore", "abc"), 0);
    assert.equal(dflt("minScore", "-20"), 0, "below the range falls back, it does not go negative");
    assert.equal(dflt("maxScore", "150"), 100, "clamped, because score is 0-100 by definition");
  });

  it("preserves the two defaults the routes used to spell out", () => {
    assert.equal(intParam(new URLSearchParams(""), "minScore", 0, 0, 100), 0);
    assert.equal(intParam(new URLSearchParams(""), "maxScore", 100, 0, 100), 100);
  });
});
