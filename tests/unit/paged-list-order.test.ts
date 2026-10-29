// #74: five doors cut a page out of a tie, so a caller walking `?page=1..totalPages` got some rows
// twice and others not at all. Measured on `origin/main` (`ff38306`) on the running app first, in
// this session's own runtime (`:3435`, database `leadworks_r74`, Redis 6418, throwaway worktree)
// over crowds written in one transaction each — 13 leads all at `score=50`, nine sources, nine jobs,
// nine exports and nine lists all sharing one `createdAt`, because `now()` is the transaction
// timestamp (`/tmp/opencode/r74_press.py` → `/tmp/opencode/r74_press_ab.log`):
//
//   GET /api/leads?limit=3 walked p1..p5 (total=13, totalPages=5)
//     p1 ld_r74_06 ld_r74_09 ld_r74_00 | p2 ld_r74_03 ld_r74_08 ld_r74_00 | …
//     -> 13 rows returned, 12 distinct: ld_r74_00 on two pages, ld_r74_02 on none
//   GET /api/leads?limit=2                 -> 11 distinct of 13
//   GET /api/leads?limit=4 / 5 / 7         -> all 13, so the page size decides it
//   GET /api/{sources,jobs,exports,lead-lists}?limit=2 -> 8 distinct of 9, one row repeated
//   GET /api/leads?limit=3&page=1                      -> tied06, tied09, tied00
//   GET /api/leads?limit=3&page=1&fields=email,score   -> tied12, tied11, tied10
//
// `total` and `totalPages` were correct on every one of those requests, which is what makes the
// failure silent. The fix is the app's own rule from `#45` (members ordered by `leadId`, unique in a
// list) and `RULE_PRIORITY_ORDER` (rank, then `createdAt`, then `id`): `PAGED_TIEBREAK` in
// `src/lib/pagination.ts`, ending every order a page is cut from.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openapiOperations } from "../../src/lib/openapi";
import { PAGED_TIEBREAK } from "../../src/lib/pagination";
import { blankComments } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** A column a window cannot tie on, or one of the two shared rules that end on one. */
const UNIQUE_TAIL = /^(?:PAGED_TIEBREAK|RULE_PRIORITY_ORDER|\{\s*(?:id|leadId):\s*"(?:asc|desc)"\s*\})$/;

/** Every route file, by its path from the repo root. */
const API_ROOT = fileURLToPath(new URL("../../src/app/api/", import.meta.url));

function routeFiles(dir = API_ROOT, base = "src/app/api/"): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full, `${base}${entry}/`));
    else if (entry.endsWith(".ts")) found.push(`${base}${entry}`);
  }
  return found;
}

/** The object literal an index sits inside: back to the unmatched `{`, forward to its `}`. */
function enclosingObject(code: string, index: number): string {
  let depth = 0;
  let start = -1;
  for (let i = index; i-- > 0; ) {
    const ch = code[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth-- === 0) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return "";
  depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

/** The expression a `orderBy:` is given, read to the end of its brackets or to the next comma. */
function orderByValue(code: string, colon: number): string {
  let i = colon + "orderBy:".length;
  while (code[i] === " ") i++;
  const open = code[i];
  if (open === "[" || open === "{") {
    let depth = 0;
    for (let j = i; j < code.length; j++) {
      if (code[j] === "[" || code[j] === "{") depth++;
      else if (code[j] === "]" || code[j] === "}") {
        if (--depth === 0) return code.slice(i, j + 1);
      }
    }
    return code.slice(i);
  }
  const stop = code.slice(i).search(/[,}\n]/);
  return stop < 0 ? code.slice(i) : code.slice(i, i + stop);
}

/** Every `orderBy:` in a file: the value it is given and the object that holds it. */
function orderSites(file: string): { where: string; order: string; window: string }[] {
  const code = blankComments(at(`../../${file}`));
  const sites: { where: string; order: string; window: string }[] = [];
  for (const match of code.matchAll(/orderBy:/g)) {
    const index = match.index ?? 0;
    sites.push({
      where: file,
      order: orderByValue(code, index).replace(/\s+/g, " ").trim(),
      window: enclosingObject(code, index),
    });
  }
  return sites;
}

const PAGED_FILES = routeFiles().filter((file) => blankComments(at(`../../${file}`)).includes("skip:"));
const SLICING_ORDERS = PAGED_FILES.flatMap(orderSites).filter((site) => /skip:|take:/.test(site.window));

describe("#74 the tiebreak is one rule, written where its readers can find it", () => {
  it("is the id, ascending, and nothing else", () => {
    assert.deepEqual(PAGED_TIEBREAK, { id: "asc" });
  });

  it("names the round that disclosed it, the door that already did it, and why a crowd ties", () => {
    const lib = at("../../src/lib/pagination.ts");
    assert.match(lib, /#48/, "recorded as the limit #48 measured and deferred, not invented here");
    assert.match(lib, /#45/, "the rule is #45's, taken from the membership window to the doors that page");
    assert.match(lib, /transaction timestamp/, "why `createdAt desc` ties in the real shape, not only in a test");
  });

  it("is imported by the five collection doors rather than re-typed into them", () => {
    for (const file of [
      "src/app/api/leads/route.ts",
      "src/app/api/sources/route.ts",
      "src/app/api/jobs/route.ts",
      "src/app/api/exports/route.ts",
      "src/app/api/lead-lists/route.ts",
    ]) {
      const clean = blankComments(at(`../../${file}`));
      assert.match(clean, /import \{[^}]*PAGED_TIEBREAK[^}]*\} from "@\/lib\/pagination"/, `${file} reads the shared rule`);
      const sites = orderSites(file).filter((site) => /skip:|take:/.test(site.window));
      assert.equal(sites.length, 1, `${file} slices exactly one window`);
      assert.match(sites[0].order, /PAGED_TIEBREAK\]?\s*$/, `${file} ends its order with it, not with a re-typed key`);
      assert.equal(/orderBy:[^,\n]*\{\s*id:\s*"(?:asc|desc)"\s*\}/.test(clean), false, `${file} does not re-type the key it imports`);
    }
  });
});

/** The key a window's order ends on: the last element of the array, or the whole value. */
function lastOrderKey(order: string): string {
  if (!order.startsWith("[")) return order;
  const parts = order.slice(1, -1).split(",");
  return (parts.at(-1) ?? "").trim();
}

describe("#74 the census: no page is ever cut out of a tie again", () => {
  it("names exactly the seven doors that slice a page", () => {
    assert.deepEqual(
      [...new Set(SLICING_ORDERS.map((site) => site.where))].sort(),
      [
        "src/app/api/enrichment-rules/route.ts",
        "src/app/api/exports/route.ts",
        "src/app/api/jobs/route.ts",
        "src/app/api/lead-lists/[id]/route.ts",
        "src/app/api/lead-lists/route.ts",
        "src/app/api/leads/route.ts",
        "src/app/api/sources/route.ts",
      ],
      "the paging surface, read out of the routes rather than asserted",
    );
  });

  it("finds no slicing order that ends on a column rows can share", () => {
    const offenders = SLICING_ORDERS.filter((site) => !UNIQUE_TAIL.test(lastOrderKey(site.order)));
    assert.deepEqual(
      offenders.map((site) => `${site.where} ${site.order}`),
      [],
      "every window that skips or takes ends on a key unique within it",
    );
  });

  it("leaves the two that were already total alone, and says which rule makes them so", () => {
    const rules = blankComments(at("../../src/app/api/enrichment-rules/route.ts"));
    assert.match(rules, /orderBy: RULE_PRIORITY_ORDER/, "the rules door is ranked by the shared three-key order");
    const priority = at("../../src/lib/rule-priority.ts");
    assert.match(priority, /\{\s*priority:\s*"desc"\s*\},\s*\{\s*createdAt:\s*"asc"\s*\},\s*\{\s*id:\s*"asc"\s*\}/);
    const members = blankComments(at("../../src/app/api/lead-lists/[id]/route.ts"));
    assert.match(members, /orderBy:\s*\{\s*leadId:\s*"asc"\s*\}/, "#45's window, unique inside a list");
    assert.equal(members.includes("PAGED_TIEBREAK"), false, "and it does not need this round's key");
  });

  it("does not reach for a tiebreaker where no page is cut", () => {
    const leads = blankComments(at("../../src/app/api/leads/route.ts"));
    const holderWindow = enclosingObject(leads, leads.indexOf('orderBy: { createdAt: "asc" }'));
    assert.equal(/skip:|take:/.test(holderWindow), false, "the email-holder lookup reads a band, not a page");
    assert.match(holderWindow, /select:\s*\{\s*id:\s*true,\s*email:\s*true\s*\}/);
  });
});

describe("#74 the map says which order each page is cut from", () => {
  const op = (id: string) => openapiOperations.find((entry) => entry.operation.id === id)!.operation;

  it("six list doors document `page`, and each names its own primary key", () => {
    const primary = {
      "leads.list": "score desc",
      "sources.list": "createdAt desc",
      "jobs.list": "createdAt desc",
      "exports.list": "createdAt desc",
      "leadLists.list": "createdAt desc",
      "rules.list": "priority desc",
    } as const;
    for (const [id, order] of Object.entries(primary)) {
      const page = (op(id).query ?? []).find(([name]) => name === "page");
      assert.ok(page, `${id} documents a page`);
      assert.match(page![1], /total order/, `${id} promises a reproducible slice`);
      assert.ok(page![1].includes(order), `${id} names ${order}: ${page![1]}`);
      assert.match(page![1], /`id asc`|`id asc`/, `${id} names the tiebreaker`);
    }
  });

  it("the membership door documents the page it has always answered with", () => {
    const names = (op("leadLists.get").query ?? []).map(([name]) => name);
    assert.ok(names.includes("page") && names.includes("limit"), `leadLists.get documents its page: ${names.join(", ")}`);
    const page = (op("leadLists.get").query ?? []).find(([name]) => name === "page")!;
    assert.match(page[1], /leadId asc/, "and says what makes that page reproducible");
    assert.match(op("leadLists.get").responses?.["200"] ?? "", /memberPage/);
  });

  it("the map agrees with the routes: every door that slices declares `page`", () => {
    const silent = PAGED_FILES.filter((file) => {
      const path = `/api/${file
        .replace("src/app/api/", "")
        .replace(/\/route\.ts$/, "")
        .replace("[id]", "{id}")}`;
      const entry = openapiOperations.find((candidate) => candidate.path === path && candidate.method === "get");
      if (!entry) return true;
      return !(entry.operation.query ?? []).some(([name]) => name === "page");
    });
    assert.deepEqual(silent, [], "a paging door with no `page` in the contract is a page a caller cannot ask for");
  });

  it("the deep file was rebuilt from the contract, not edited", () => {
    const deep = at("../../public/llms-full.txt");
    assert.match(deep, /`GET \/api\/lead-lists` — The workspace's lists, one page of them at a time/);
    assert.equal(deep.includes("1-based page number, cut out of a total order"), false, "that file carries summaries and auth, not query descriptions");
  });
});

describe("#74 the README records what the press measured", () => {
  const readme = at("../../README.md").replace(/\s+/g, " ");

  it("carries the four measured failures, in the numbers the press printed", () => {
    assert.match(readme, /13 rows returned, 12 distinct: `ld_r74_00` on two pages, `ld_r74_02` on none/);
    assert.match(readme, /\?limit=2 -> 11 distinct of 13/);
    assert.match(readme, /\{sources,jobs,exports,lead-lists\}\?limit=2 -> 8 distinct of 9/);
    assert.match(readme, /one door, one page, two answers/);
  });

  it("attributes #48's disclosed limit to the build it was measured on and names this round as the decision", () => {
    assert.match(readme, /The order had no tiebreaker — \*this is the limit #74 took\*/);
    assert.match(readme, /93,129 and 93,517/, "#48's own numbers stay on the page");
    assert.match(readme, /#74 made that decision, at all five paged doors/);
  });

  it("no longer promises a `?orderBy=` parameter that no door has ever read", () => {
    assert.equal(readme.includes("GET /api/leads?orderBy=score desc"), false, "the sort order sentence was corrected with the round that owns ordering");
    assert.match(readme, /no `\?orderBy=` asks it for another|and no \`\?orderBy=\`/);
  });

  it("says what the fix does not promise", () => {
    assert.match(readme, /reproducible, not static/);
    assert.match(readme, /sequential, not simultaneous/);
    assert.match(readme, /hand-written ids \(`ld_r74_00`…`_12`\)/, "the seeded ids are named as hand-written, not cuids");
  });
});
