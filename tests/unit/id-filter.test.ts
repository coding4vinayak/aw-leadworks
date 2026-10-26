// #58: three read doors filtered by a row the caller named and never resolved. Measured
// on `origin/main` (65bd942) on the running app — `:3381` over `leadworks_r58`, three leads
// on `list-alpha`, two jobs on `src-alpha`, two exports on `profile-alpha`, and a second
// tenant holding `list-foreign` / `src-foreign` / `profile-foreign` so a foreign id is a
// real row rather than an invented string — logs `/tmp/opencode/r58_measure.log` and
// `r58_measure_b.log`:
//
//   GET /api/leads?listId=<list-beta, real and empty>   200 total=0   the honest one
//   GET /api/leads?listId=nope                          200 total=0
//   GET /api/leads?listId=<another tenant's list>       200 total=0
//   GET /api/leads?listId=%20<real id>                  200 total=0   the padding became the id
//   GET /api/leads?listId=<a>&listId=<b>                200 total=3   one of the two, silently
//
// `jobs?sourceId=` and `exports?profileId=` answered identically on their own columns, and
// every one of those presses is a 422 at the matching write door on the same build:
// `sourceId is not an id this workspace has: nope`. The door that writes the reference
// checked it; the door that reads by it did not.
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idFilterParam, unknownIdError } from "../../src/lib/ids";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ask = (query: Record<string, string>) => new URLSearchParams(query);

/** The refusal's own status and body, read once the way the door's caller reads it. */
async function refusal(output: { id: string | null; error: null | Response }) {
  assert.ok(output.error, "this helper is for the answer that refuses");
  const response = output.error as Response;
  return { status: response.status, json: (await response.json()) as { error: string; unknownIds?: string[] } };
}

/** A table that holds exactly `held`, and nothing else — the scoping is the door's job. */
const holds = (...held: string[]) => async (id: string) => held.includes(id);

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const here = `${dir}${entry.name}`;
    if (entry.isDirectory()) sourceFiles(`${here}/`, into);
    else if (entry.name.endsWith(".ts")) into.push(here);
  }
  return into;
}

describe("idFilterParam: the difference between an empty crowd and an unread filter", () => {
  it("treats absent, empty and whitespace-only as no opinion", async () => {
    // A form whose select was left alone sends `?listId=`, and `POST /api/jobs` reads a
    // null `sourceId` as "no source": the read door has to read it the same way or the
    // whole page disappears for a caller who asked for the whole page.
    for (const query of ["", "limit=10", "listId=", "listId=%20", "listId=%09", "status=NEW"]) {
      const out = await idFilterParam(new URLSearchParams(query), "listId", holds());
      assert.equal(out.id, null, query);
      assert.equal(out.error, null, query);
    }
  });

  it("does not mistake a neighbouring parameter for an id", async () => {
    const out = await idFilterParam(ask({ workspaceId: "ws_other", listId_: "x" }), "listId", holds());
    assert.equal(out.id, null);
    assert.equal(out.error, null);
  });

  it("trims: the padding is not part of the id", async () => {
    const seen: string[] = [];
    const out = await idFilterParam(ask({ listId: "  cmReal  " }), "listId", async (id) => {
      seen.push(id);
      return id === "cmReal";
    });
    assert.equal(out.id, "cmReal");
    assert.deepEqual(seen, ["cmReal"], "the door looks the padded value up, not the raw one");
  });

  it("counts the same id twice as the one id it is", async () => {
    const out = await idFilterParam(new URLSearchParams([["listId", "cmReal"], ["listId", "cmReal "]]), "listId", holds("cmReal"));
    assert.equal(out.id, "cmReal");
    assert.equal(out.error, null);
  });

  it("refuses two ids rather than quietly answering one of them", async () => {
    // Base behaviour was `?listId=a&listId=b` → a's page with no hint that b was dropped.
    const out = await idFilterParam(new URLSearchParams([["listId", "cmA"], ["listId", "  cmB  "]]), "listId", holds("cmA", "cmB"));
    const { status, json } = await refusal(out);
    assert.equal(status, 400);
    assert.match(
      json.error,
      /^listId was given 2 ids \("cmA", "cmB"\); this filter compares listId to one of them$/,
    );
    assert.equal(out.id, null);
  });

  it("refuses before it looks either one up", async () => {
    const looked: string[] = [];
    await idFilterParam(new URLSearchParams([["sourceId", "cmA"], ["sourceId", "cmB"]]), "sourceId", async (id) => {
      looked.push(id);
      return true;
    });
    assert.deepEqual(looked, [], "a request that will be refused costs the table no query");
  });
});

describe("an id that does not resolve here answers the write door's 422", () => {
  it("names the id and carries the machine-readable list", async () => {
    const out = await idFilterParam(ask({ profileId: "nope" }), "profileId", holds("xp_real"));
    const { status, json } = await refusal(out);
    assert.equal(status, 422);
    assert.equal(json.error, "profileId is not an id this workspace has: nope");
    assert.deepEqual(json.unknownIds, ["nope"]);
  });

  it("is the same response POST would have sent for the same typo", async () => {
    // Byte-identical, not merely the same status: one client handles a typo in a query
    // string and a typo in a body without telling the two doors apart.
    const out = await idFilterParam(ask({ sourceId: "nope" }), "sourceId", holds());
    const mine = await refusal(out);
    const theirs = unknownIdError("sourceId", "nope");
    assert.equal(mine.status, theirs.status);
    assert.deepEqual(mine.json, (await theirs.json()) as { error: string; unknownIds: string[] });
  });

  it("answers a foreign id through the same branch as a missing one", async () => {
    // The lookup the door passes is scoped to the workspace, so another tenant's row is
    // not found; the sentence is the "does not have" one and says nothing about its owner.
    const out = await idFilterParam(ask({ listId: "cmForeign" }), "listId", holds());
    const { status, json } = await refusal(out);
    assert.equal(status, 422);
    assert.equal(json.error, "listId is not an id this workspace has: cmForeign");
    assert.doesNotMatch(json.error, /other tenant|belongs to/i);
  });

  it("hands the door the id it resolved, and nothing when the caller named none", async () => {
    assert.equal((await idFilterParam(ask({ listId: "cmReal" }), "listId", holds("cmReal"))).id, "cmReal");
    assert.equal((await idFilterParam(ask({ status: "NEW" }), "listId", holds("cmReal"))).id, null);
  });
});

describe("the three doors resolve the id they filter by", () => {
  const doors = [
    { file: "../../src/app/api/leads/route.ts", name: "listId", table: "leadList", var: "list", assign: "where.listMemberships = { some: { listId: list.id } };" },
    { file: "../../src/app/api/jobs/route.ts", name: "sourceId", table: "source", var: "source", assign: "where.sourceId = source.id;" },
    { file: "../../src/app/api/exports/route.ts", name: "profileId", table: "exportProfile", var: "profile", assign: "where.profileId = profile.id;" },
  ];
  for (const door of doors) {
    it(`${door.name} goes through idFilterParam against ${door.table}`, () => {
      const reading = at(door.file);
      const call = new RegExp(
        `idFilterParam\\(\\s*searchParams,\\s*"${door.name}",\\s*\\(id\\)\\s*=>\\s*prisma\\.${door.table}\\.count\\(\\{\\s*where: \\{ workspaceId, id \\}`,
      );
      assert.match(reading, call, "the lookup has to be scoped to the workspace the door is reading");
      assert.match(reading, /if \((\w+)\.error\) return \1\.error;/, "a refusal returns before the query");
      assert.ok(reading.includes(`if (${door.var}.id) ${door.assign}`), `${door.name} filters by the resolved id, not the raw word`);
    });

    it(`${door.name} is no longer read straight off the query string`, () => {
      const reading = at(door.file);
      assert.doesNotMatch(reading, new RegExp(`searchParams\\.get\\("${door.name}"\\)`));
      assert.doesNotMatch(reading, new RegExp(`if \\(${door.name}\\) where\\.`), "the unresolved assignment this round removed");
    });
  }

  it("the census: every id-shaped query a door reads is either resolved or this app's own workspace", () => {
    // `workspaceId` is the one id a door takes without resolving: `authedWorkspaceId`
    // decides between the key's own workspace and a claim it refuses, and the routes that
    // read `?action=` branch on a word, not a row. Anything else in this set is a
    // reference to a row and has to be looked up before it filters.
    const unresolved: string[] = [];
    for (const file of sourceFiles("../../src/app/api/")) {
      const reading = at(file);
      for (const match of reading.matchAll(/searchParams\.(?:get|getAll)\("([A-Za-z]*[a-z]Id)"\)/g)) {
        const name = match[1];
        if (name === "workspaceId") continue;
        if (!new RegExp(`idFilterParam\\(\\s*searchParams,\\s*"${name}"`).test(reading)) unresolved.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(unresolved, [], `${unresolved.length} door(s) filter by an id they never resolved: ${unresolved.join("; ")}`);
  });
});

describe("the contract says so", () => {
  const listed = ["leads.list", "jobs.list", "exports.list"];
  const words: Record<string, string> = { "leads.list": "listId", "jobs.list": "sourceId", "exports.list": "profileId" };

  for (const id of listed) {
    const operation = openapiOperations.find((op) => op.operation.id === id)!;
    const name = words[id];

    it(`${id} documents that ${name} is resolved, not guessed`, () => {
      const line = (operation.operation.query as [string, string][]).find(([one]) => one === name);
      assert.ok(line, `${id} still documents a ${name} parameter`);
      assert.match(line![1], /refused, not answered with an empty page/);
    });

    it(`${id} prices the 422 that refusal costs`, () => {
      const responses = operation.operation.responses as Record<string, string>;
      assert.match(responses["422"], new RegExp(`\`${name}\` this workspace does not have, named`));
      assert.match(responses["422"], /POST .* gives that id in a body/);
      assert.match(responses["400"], new RegExp(`\`${name}\` given two ids at once`));
    });
  }

  it("exactly the three doors that read by an id document it this way", () => {
    const documenting = openapiOperations
      .filter((op) => ((op.operation.query as [string, string][]) ?? []).some(([one, prose]) => /[a-z]Id$/.test(one) && /refused, not answered/.test(prose)))
      .map((op) => op.operation.id as string)
      .sort();
    assert.deepEqual(documenting, listed.slice().sort());
  });
});
