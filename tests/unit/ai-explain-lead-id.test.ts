// #72: `GET /api/ai/explain-lead?id=` is the one door in this app that reads a row the
// caller names out of a query string, and it read the name with `searchParams.get("id")` —
// no trim, and the first of two spellings taken silently. Measured on the running app
// (`15e100e` built in a fresh worktree, served on `:3431` over this session's own
// `leadworks_r72`, private Redis 6414, two workspaces, keys in `0600` files printed nowhere;
// tenant A held `ld_r72_ana` score 40 and `ld_r72_bo` score 71 on a list `lst_r72_a`, tenant B
// held `ld_r72_cy` score 88; `/tmp/opencode/r72_press_ab.log`):
//
//   ?id=ld_r72_ana                      200 bytes=925 score=40    the control
//   ?id=%20ld_r72_ana%20                404 "lead not found"      a row this tenant holds
//   ?id=%20ld_r72_ana                   404 "lead not found"
//   ?id=ld_r72_ana%20                   404 "lead not found"
//   ?id=%20ld_r72_ana&id=ld_r72_ana     404 "lead not found"      `get` returns the first
//   ?id=ld_r72_ana&id=ld_r72_bo         200 bytes=925 score=40    bo dropped without a word
//   ?id=…&id=…&id=nope                  200 bytes=925 score=40    three named, one answered
//   ?id=%20                             404 "lead not found"      whitespace reached the db
//   ?id=ld_r72_cy  (tenant A's key)     404 "lead not found"      correct, and it stays
//   ?id=nope                            404 "lead not found"      correct, and it stays
//   ?id= / absent                       400 "id required"         correct, and it stays
//
// On that same build the sibling doors answered the identical bytes the other way:
// `GET /api/leads?listId=%20lst_r72_a%20` returned the two leads on the trimmed list, and
// `?listId=lst_r72_a&listId=nope` was a `400 listId was given 2 ids ("lst_r72_a", "nope");
// this filter compares listId to one of them`. One app, two answers for one spelling, because
// only one of those doors read its name through `idFilterParam` (`src/lib/ids.ts`).
//
// The fix is that reading, split out of the resolution step it used to live inside: a door
// that *fetches* the row an id names needs the trim and the one-name refusal, and keeps its
// own `404 lead not found` for a row this workspace does not hold — the answer
// `GET /api/leads/{id}` gives for the same shape, and not this round's to re-decide.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idFilterParam, oneIdParam } from "../../src/lib/ids";
import { openapiOperations } from "../../src/lib/openapi";
import { blankComments, functionBody } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const ANA = "ld_r72_ana";
const BO = "ld_r72_bo";
const query = (pairs: [string, string][]) => new URLSearchParams(pairs);

/** The refusal's own status and body, read the way the door's caller reads them. */
async function refusal(output: { value: string | null; error: null | Response }) {
  assert.ok(output.error, "this helper is for the answer that refuses");
  const response = output.error as Response;
  return { status: response.status, json: (await response.json()) as { error: string } };
}

const doorSource = at("../../src/app/api/ai/explain-lead/route.ts");
const doorBody = functionBody(blankComments(doorSource), "GET_impl")!;
const idsSource = blankComments(at("../../src/lib/ids.ts"));

describe("the padding a name arrives in is not part of the name", () => {
  it("reproduces the read that answered 404 for a row the tenant holds", () => {
    // The base line, offline: `get` hands back the bytes with their spaces, and a Prisma
    // `where: { id }` compares them literally. Pinning this is what makes the fix's
    // difference a fact about the reading rather than a story about the database.
    const params = new URL(`http://x/api/ai/explain-lead?id=%20${ANA}%20`).searchParams;
    assert.equal(params.get("id"), ` ${ANA} `);
    assert.notEqual(params.get("id"), ANA, "and that is not the id the row is stored under");
  });

  it("trims the id from either end and both", () => {
    for (const spelled of [` ${ANA}`, `${ANA} `, ` ${ANA} `, `\t${ANA}\n`]) {
      assert.equal(oneIdParam(query([["id", spelled]]), "id").value, ANA);
    }
  });

  it("names nothing when the caller spelled nothing", () => {
    // Absent, empty, and padding-only all reach the door as "no id", which is the branch
    // that answers `400 id required`. The third leg was the base build's `404` — a space
    // sent to the database as an id.
    assert.equal(oneIdParam(query([]), "id").value, null);
    assert.equal(oneIdParam(query([["id", ""]]), "id").value, null);
    assert.equal(oneIdParam(query([["id", "   "]]), "id").value, null);
  });

  it("takes the same name twice as one name", () => {
    // `?id=%20ana&id=ana` is one row spelled twice, which is what the base build answered
    // with a 404 because `get` returned the padded half.
    const asked = oneIdParam(query([["id", ` ${ANA}`], ["id", ANA]]), "id");
    assert.equal(asked.value, ANA);
    assert.equal(asked.error, null);
  });

  it("refuses two different ids and says both", async () => {
    const asked = oneIdParam(query([["id", ANA], ["id", BO]]), "id");
    assert.equal(asked.value, null);
    const refused = await refusal(asked);
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, `id was given 2 ids ("${ANA}", "${BO}"); this filter compares id to one of them`);
  });

  it("counts what was given, including an id that is simply wrong", async () => {
    const three = await refusal(oneIdParam(query([["id", ANA], ["id", BO], ["id", "nope"]]), "id"));
    assert.equal(three.status, 400);
    assert.match(three.json.error, /^id was given 3 ids \("[^"]+", "[^"]+", "nope"\)/);
  });
});

describe("the door that filters a table answers exactly as it did", () => {
  it("shares the reading, so the refusal is one sentence in this app", async () => {
    const asked = await idFilterParam(query([["listId", ANA], ["listId", BO]]), "listId", async () => true);
    assert.equal(asked.id, null);
    const refused = await refusal({ value: asked.id, error: asked.error });
    assert.equal(refused.json.error, `listId was given 2 ids ("${ANA}", "${BO}"); this filter compares listId to one of them`);
  });

  it("still trims before it resolves", async () => {
    const seen: string[] = [];
    const asked = await idFilterParam(query([["listId", ` ${ANA} `]]), "listId", (id) => {
      seen.push(id);
      return Promise.resolve(id === ANA);
    });
    assert.equal(asked.id, ANA);
    assert.deepEqual(seen, [ANA], "the padding never reached the lookup");
  });

  it("still refuses a name this workspace does not have, with the 422 that is its own", async () => {
    const asked = await idFilterParam(query([["listId", "nope"]]), "listId", async () => false);
    assert.equal(asked.id, null);
    const refused = await refusal({ value: asked.id, error: asked.error });
    assert.equal(refused.status, 422, "a filter's typo is not a fetch's miss");
    assert.equal(refused.json.error, "listId is not an id this workspace has: nope");
  });

  it("still treats an empty filter as no filter", async () => {
    assert.equal((await idFilterParam(query([["listId", ""]]), "listId", async () => false)).id, null);
  });
});

describe("the door reads its name through the shared rule", () => {
  it("calls oneIdParam and returns its refusal", () => {
    assert.match(doorSource, /import \{ oneIdParam \} from "@\/lib\/ids"/);
    assert.match(doorBody, /const asked = oneIdParam\(searchParams, "id"\);/);
    assert.match(doorBody, /if \(asked\.error\) return asked\.error;/);
  });

  it("no longer asks URLSearchParams for the id by hand", () => {
    assert.doesNotMatch(doorBody, /searchParams\.get\("id"\)/, "the raw read is what produced the 404");
    assert.match(doorBody, /if \(asked\.value === null\) return NextResponse\.json\(\{ error: "id required" \}, \{ status: 400 \}\);/);
  });

  it("passes the trimmed name into a lookup that is still scoped", () => {
    assert.match(doorBody, /where: \{ id: asked\.value, workspaceId: actor\.workspaceId \}/);
  });

  it("keeps the 404 that is the honest answer for a row this workspace does not hold", () => {
    // Not this round's to move: `GET /api/leads/{id}` answers `Not found` for the same
    // shape, and another tenant's id has to mean the same thing a typo does.
    assert.match(doorBody, /if \(!lead\) return NextResponse\.json\(\{ error: "lead not found" \}, \{ status: 404 \}\);/);
    assert.doesNotMatch(doorBody, /unknownIdError/, "and the door does not borrow the filter's 422");
  });

  it("leaves everything else about the request alone", () => {
    assert.match(doorBody, /const model = searchParams\.get\("model"\) \?\? undefined;/);
    assert.match(doorBody, /claimedWorkspaceId: searchParams\.get\("workspaceId"\),/);
    assert.match(doorSource, /export const GET = withAuth\(withAiAuth\(GET_impl\)\);/);
    assert.match(doorBody, /reason: "No LLM_API_KEY set/, "the arithmetic still comes back with the verdict");
  });
});

describe("the refactor did not move the doors that were already judging", () => {
  it("keeps the three filter doors on idFilterParam", () => {
    for (const [file, name] of [
      ["../../src/app/api/leads/route.ts", "listId"],
      ["../../src/app/api/jobs/route.ts", "sourceId"],
      ["../../src/app/api/exports/route.ts", "profileId"],
    ]) {
      assert.match(blankComments(at(file)), new RegExp(`idFilterParam\\(searchParams, "${name}"`), `${name} still resolves before it filters`);
    }
  });

  it("has exactly one door reading a name without resolving it, and that door is this round's", () => {
    const readers = ["../../src/app/api/leads/route.ts", "../../src/app/api/jobs/route.ts",
      "../../src/app/api/exports/route.ts", "../../src/app/api/ai/explain-lead/route.ts",
      "../../src/app/api/sources/route.ts", "../../src/app/api/lead-lists/route.ts"]
      .filter((file) => at(file).includes("oneIdParam("));
    assert.deepEqual(readers, ["../../src/app/api/ai/explain-lead/route.ts"]);
  });

  it("leaves ids.ts's own refusal in one place", () => {
    assert.equal((idsSource.match(/was given \$\{asked\.length\} ids/g) ?? []).length, 1,
      "the sentence is not typed twice, so it cannot drift twice");
    assert.match(idsSource, /const asked = oneIdParam\(searchParams, name\);/);
  });
});

describe("the contract says who judges the name and what a miss means", () => {
  const door = openapiOperations.find((entry) => entry.operation.id === "ai.explainLead")!;

  it("documents the trim, the double spelling and the 404", () => {
    const described = (door.operation.query ?? []).find(([name]) => name === "id");
    assert.ok(described, "ai.explainLead documents `id`");
    assert.match(described[1], /Spaces around it trim/);
    assert.match(described[1], /refused rather than answered with whichever one the door happened to read first/);
    assert.match(described[1], /`404 lead not found`, which is what another tenant's id and a typo both mean here/);
  });

  it("prices the refusal it now makes", () => {
    const responses = door.operation.responses ?? {};
    assert.equal(responses["200"], "The explanation, or why there is none.", "the answer that was promised is still promised");
    assert.match(responses["400"] ?? "", /No `id` at all, or one `id` given two different values\./);
  });

  it("leaves the other two parameters and the path as they were", () => {
    const query_ = door.operation.query ?? [];
    assert.equal(query_.find(([name]) => name === "workspaceId")?.[1], "The workspace to read. Defaults to the key's own.");
    assert.equal(query_.find(([name]) => name === "model")?.[1], "The model to write the explanation with.");
    assert.deepEqual(query_.map(([name]) => name), ["workspaceId", "id", "model"], "this round advertised no new parameter");
    assert.equal(door.path, "/api/ai/explain-lead");
    assert.equal(door.operation.auth, "key");
  });
});
