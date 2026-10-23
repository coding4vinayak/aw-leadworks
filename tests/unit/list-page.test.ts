// #45 — `GET /api/lead-lists/{id}` says how many members there are and hands back the rest,
// pinned offline.
//
// `include: { members: { include: { lead: true }, take: 100 } }` was the whole read: no `orderBy`,
// no `skip`, and nothing in the response about what it left out. Measured on the running app before
// this file existed, on a dynamic list whose filter #44 had just made mean something:
//
//   POST /api/lead-lists/{id}?action=refresh  -> {"matched":150,"added":150,"members":150}
//   GET  /api/lead-lists/{id}                 -> `members` 100 rows, 163,031 bytes, no total named
//   GET  ?limit=5 ?page=2&limit=5 ?memberOffset=100 -> the same 100 rows, every one of them ignored
//   GET  /api/lead-lists                      -> {_count:{members:150}} — the collection knew
//
// `lib/list-page.ts` decides what the answer says, and this file pins three things on top of the
// arithmetic: that the order the page is cut on is *total* (a fact about `schema.prisma`, not about
// this file's hope), that the words are the ones `lib/job-report.ts` already uses for the same
// shape of sentence, and that the door actually calls them in that order. No database, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import { memberPage } from "../../src/lib/list-page";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const moduleSource = at("../../src/lib/list-page.ts");
const routeSource = at("../../src/app/api/lead-lists/[id]/route.ts");
const schemaSource = at("../../prisma/schema.prisma");
const jobReportSource = at("../../src/lib/job-report.ts");
const getCode = blankComments(functionBody(routeSource, "GET_impl") ?? "");

describe("the arithmetic of a page that admits it is a page", () => {
  it("counts the whole membership, not the rows it carried", () => {
    const p = memberPage(150, 100, 1, 100);
    assert.equal(p.recorded, 150);
    assert.equal(p.returned, 100);
    assert.equal(p.truncated, true);
    assert.equal(p.totalPages, 2);
  });

  it("says the last short page is not truncated", () => {
    const p = memberPage(150, 50, 2, 100);
    assert.equal(p.truncated, false);
    assert.equal(p.totalPages, 2);
    assert.equal(p.page, 2);
  });

  it("holds `truncated` to rows past this page, not to a short answer", () => {
    // A page past the end returns nothing. It is not truncated: there is no row this answer fails
    // to carry that any page would have carried.
    const p = memberPage(150, 0, 7, 100);
    assert.equal(p.returned, 0);
    assert.equal(p.truncated, false);
    assert.equal(p.totalPages, 2);
  });

  it("answers a list with no members as 0 pages, not as page 0 of 1", () => {
    const p = memberPage(0, 0, 1, 100);
    assert.deepEqual(p, {
      recorded: 0, returned: 0, page: 1, limit: 100, totalPages: 0, truncated: false,
    });
  });

  it("keeps the exact-multiple case honest", () => {
    assert.equal(memberPage(200, 100, 1, 100).truncated, true);
    assert.equal(memberPage(200, 100, 2, 100).truncated, false);
    assert.equal(memberPage(200, 100, 2, 100).totalPages, 2);
  });

  it("is the same arithmetic for the page a caller asked for, not the one it defaulted to", () => {
    const p = memberPage(150, 10, 1, 10);
    assert.equal(p.totalPages, 15);
    assert.equal(p.truncated, true);
    assert.equal(p.limit, 10);
  });

  it("returns exactly the six facts and no others", () => {
    assert.deepEqual(Object.keys(memberPage(1, 1, 1, 1)).sort(),
      ["limit", "page", "recorded", "returned", "totalPages", "truncated"]);
  });
});

describe("the module that decides it", () => {
  it("holds no query, no clock, no disk and no import at all", () => {
    assert.equal(moduleSource.includes("prisma"), false);
    assert.equal(moduleSource.includes("await"), false);
    assert.equal(moduleSource.includes("new Date("), false);
    assert.equal(moduleSource.includes("readFileSync"), false);
    assert.equal(moduleSource.includes("process.env"), false);
    assert.equal(/^\s*import\s/m.test(moduleSource), false, "the file imports nothing");
  });

  it("says the words `lib/job-report.ts` already says for the same shape of sentence", () => {
    // `results: { recorded, returned, truncated }` is the precedent; two vocabularies for "the
    // array you got is not the crowd" is how the two drift.
    for (const word of ["recorded", "returned", "truncated"]) {
      assert.match(jobReportSource, new RegExp(`\\b${word}\\b`));
      assert.match(moduleSource, new RegExp(`\\b${word}\\b`));
    }
  });
});

describe("the order the page is cut on", () => {
  it("is a total order because the schema makes the key unique per list", () => {
    const model = schemaSource.slice(schemaSource.indexOf("model LeadListMember"));
    assert.match(model.slice(0, model.indexOf("\n}")), /@@unique\(\[listId, leadId\]\)/);
  });

  it("orders members by that key, so two pages cannot overlap and a page after the end is empty", () => {
    assert.match(getCode, /orderBy:\s*\{\s*leadId:\s*"asc"\s*\}/);
  });

  it("takes the page from the same numbers it echoes back", () => {
    assert.match(getCode, /skip:\s*\(page\s*-\s*1\)\s*\*\s*limit/);
    assert.match(getCode, /take:\s*limit/);
    assert.equal(getCode.includes("take: 100"), false, "the literal ceiling is gone from the door");
  });
});

describe("the door, scanned rather than trusted", () => {
  it("asks the page through the app's own clamp, at the size this door has always returned", () => {
    assert.match(getCode, /pageParams\(searchParams,\s*100\)/);
  });

  it("counts the membership in the database instead of inferring it from the rows it carried", () => {
    assert.match(getCode, /prisma\.leadListMember\.count\(\{\s*where:\s*\{\s*listId:\s*id\s*\}\s*\}\s*\)/);
    // The count and the read are one round trip apart, not one after the other.
    assert.ok(getCode.indexOf("Promise.all") < getCode.indexOf("leadListMember.count"));
  });

  it("answers the list it read plus the page it took, and nothing about the row is dropped", () => {
    assert.match(getCode, /NextResponse\.json\(\{\s*\.\.\.list,\s*memberPage:\s*memberPage\(recorded,\s*list\.members\.length,\s*page,\s*limit\)/);
    assert.equal(getCode.includes("return NextResponse.json(list)"), false);
  });

  it("still authenticates the workspace it read for, on every path that returns a row", () => {
    assert.ok(getCode.indexOf("assertOwns(request, list.workspaceId)")
      < getCode.indexOf("NextResponse.json({ ...list"));
    assert.match(getCode, /if \(!list\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
  });

  it("leaves the other three handlers of this file alone", () => {
    // This round is one door. The write doors are #44's and #42's business, not this diff's.
    for (const name of ["PATCH_impl", "POST_impl", "DELETE_impl"]) {
      assert.ok(functionBody(routeSource, name) !== undefined, `${name} is still here`);
    }
    assert.equal(getCode.includes("isDynamic"), false);
  });
});

describe("the same document says the same thing", () => {
  it("names the two query strings the door now reads, in the machine-readable contract", () => {
    const spec = at("../../src/lib/openapi.ts");
    const entry = spec.slice(spec.indexOf('"/api/lead-lists/{id}"'));
    const get = entry.slice(0, entry.indexOf("patch:"));
    assert.match(get, /\[\s*"page"\s*,/);
    assert.match(get, /\[\s*"limit"\s*,/);
    assert.match(get, /recorded,\s*returned,\s*page,\s*limit,\s*totalPages,\s*truncated/);
  });

  it("has the detail door in the README's API list, which did not mention it at all", () => {
    const readme = at("../../README.md");
    const line = readme.split("\n").find((l) => l.startsWith("GET    /api/lead-lists/{id}"));
    assert.ok(line, "the line exists");
    assert.equal(line!.indexOf("#"), readme.split("\n").find((l) => l.startsWith("GET    /api/lead-lists?workspaceId="))!.indexOf("#"));
    assert.match(line!, /member|members/i);
  });
});
