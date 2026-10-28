// #64 → #69a: the export door used to check that a `filterJson.listId` was a *string* and never
// asked whether the list existed. Measured on this file's own round (`e3fcc16`, `:3416` over
// `leadworks_r65`, three leads in workspace A with two on `list-alpha`, one in workspace B on
// `list-beta`, the worker allowed to run each export to its verdict; log
// `/tmp/opencode/r65_press_base2.log`, row truth from `psql … "Export"`):
//
//   POST /api/exports {filterJson:{listId:"nope"}}            201 → COMPLETED records=0 bytes=0
//   POST /api/exports {filterJson:{listId:"<workspace B's list>"}}
//                                                             201 → COMPLETED records=0 bytes=0
//   POST /api/exports {filterJson:{listId:" nope "}}          201 → COMPLETED records=0 bytes=0
//   POST /api/exports {filterJson:{listId:""}}                201 → COMPLETED records=0 bytes=0
//   POST /api/exports {filterJson:{status:"QUALIFIED",listId:"nope"}}
//                                                             201 → COMPLETED records=0 bytes=0
//   POST /api/exports {filterJson:{listId:"<A's own list>"}}  201 → COMPLETED records=2 bytes=40
//   POST /api/exports {}                                      201 → COMPLETED records=3 bytes=57
//   POST /api/exports {filterJson:{listId:42}}                400 filterJson.listId must be a string
//
// So the key's type was validated and its referent was not: an export that declares a named crowd
// delivered an empty file and reported itself finished. The two neighbouring doors answer the same
// typo on the same build — `GET /api/leads?listId=nope` is `422 listId is not an id this workspace
// has: nope` and `POST /api/jobs {sourceId:"nope",config:{}}` is `422 sourceId is not an id this
// workspace has: nope` — which is why the question belonged to the door and not to the worker.
//
// **What this file is now.** The fix shipped as #102 (`main` at `1b2f285`) before this branch could
// land, and the two implementations disagreed on exactly one decision: padding. This file asked for
// the id verbatim and refused a padded name; #102 trims inside `readExportFilter` and refuses `""`
// as not-a-name, the way `idFilterParam` already treats `?listId=` and `asStrings` treats `listIds`.
// Trunk won that argument, so the padding and `""` expectations below are **retargeted to main's
// behaviour, each with the reason in front of it** rather than relaxed until they pass. What the
// retarget keeps is the coverage trunk does not have: the census at the bottom, which walks every
// field table this app exports and fails if a body key shaped like a row reference reaches a door
// that does not resolve it before the write.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as FIELD_TABLES from "../../src/lib/fields";
import { unknownIdError } from "../../src/lib/ids";
import { CONDITION_KEYS } from "../../src/lib/rule-conditions";
import { openapiOperations } from "../../src/lib/openapi";
import {
  EXPORT_FILTER_KEYS,
  EXPORT_LIST_ID,
  exportFilter,
  exportFilterProblem,
  readExportFilter,
} from "../../src/lib/export-format";
import { blankComments, functionBody } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const post = blankComments(functionBody(at("../../src/app/api/exports/route.ts"), "POST_impl")!);

/** The 422 as its caller reads it. */
async function refusal(name: string, id: string) {
  const response = unknownIdError(name, id);
  return { status: response.status, json: (await response.json()) as { error: string; unknownIds: string[] } };
}

describe("the reader is the one place a stored filter's list name is decided", () => {
  it("names none when the filter names none", () => {
    for (const value of [undefined, null, {}, { status: "NEW" }, { minScore: 50, tags: ["hot"] }]) {
      assert.equal(exportFilter(value).filter.listId, undefined, JSON.stringify(value));
      assert.equal(exportFilter(value).problem, null, JSON.stringify(value));
    }
  });

  it("refuses a value that is not a string with the sentence the base build already said", () => {
    // Byte for byte the last row of the table above: the *type* rule was never the gap, so a
    // retarget has to leave it sounding exactly as it did.
    for (const value of [{ listId: 42 }, { listId: ["a", "b"] }, { listId: true }, { listId: {} }]) {
      assert.equal(exportFilterProblem(value), "filterJson.listId must be a string", JSON.stringify(value));
    }
  });

  it("trims the name, because that is what trunk decided", () => {
    // RETARGETED from `returns the id verbatim — padding, case and all`. #64 wanted the door to
    // store what it was sent; #102 (landed) strips padding in the reader both the door and the
    // worker go through, so `"  lst_r69_a  "` names the list instead of being refused. Measured on
    // the landed build: the padded press is `201 → COMPLETED recordCount=2 fileSize=46`, its
    // download byte-identical to the bare name's, and the stored row reads
    // `{"listId":"lst_r69_a"}`. The trim lives in the shared reader precisely so the two readers of
    // one stored row cannot disagree about which crowd it names.
    for (const value of [" nope ", "\tcmReal", " cmReal ", "cmReal"]) {
      const read = exportFilter({ listId: value });
      assert.equal(read.problem, null, JSON.stringify(value));
      assert.equal(read.filter.listId, value.trim(), JSON.stringify(value));
    }
  });

  it("refuses a name that trims to nothing, as a 400 rather than as an unknown id", () => {
    // RETARGETED from `returns the empty string, because the key's presence is the claim`. Both
    // rounds agree `""` is an assertion, not silence — a body key spelled out claims a crowd, and
    // the `""`-means-no-opinion rule belongs to a query string, where an empty box is
    // indistinguishable from no box. They disagreed about who answers: #64 filed the claim and let
    // the lookup refuse it as a 422, #102 refuses the claim itself, the way `POST /api/leads
    // {listIds:[""]}` already answers `400 every listIds entry must be a non-empty string`.
    for (const value of [{ listId: "" }, { listId: " " }, { listId: "  \t " }]) {
      assert.equal(
        exportFilterProblem(value),
        'filterJson.listId must name a list; "" is not a list',
        JSON.stringify(value),
      );
    }
  });

  it("leaves the caller's object alone while judging it", () => {
    const sent = { listId: " cmAlpha ", tags: ["hot"] };
    const read = exportFilter(sent);
    assert.equal(read.filter.listId, "cmAlpha");
    assert.deepEqual(sent, { listId: " cmAlpha ", tags: ["hot"] }, "judging is not editing");
  });

  it("is the same judgement through either door the module offers", () => {
    for (const value of [{ listId: "" }, { listId: 42 }, { status: "ACTIVE" }, { temperature: "hot" }]) {
      assert.equal(exportFilterProblem(value), exportFilter(value).problem, JSON.stringify(value));
    }
  });

  it("agrees with the worker about which list a stored row names", () => {
    const accepted = [
      undefined,
      null,
      {},
      { status: "NEW" },
      { status: "QUALIFIED", minScore: 40 },
      { listId: "cmAlpha" },
      { listId: " cmAlpha " },
      { listId: "cmAlpha", tags: ["hot"] },
    ];
    for (const value of accepted) {
      assert.equal(exportFilter(value).problem, null, JSON.stringify(value));
      assert.deepEqual(exportFilter(value).filter, readExportFilter(value), JSON.stringify(value));
    }
  });
});

describe("the export door resolves the list before the row exists", () => {
  it("asks the filter, then the database, in that order", () => {
    assert.match(post, /exportFilter\(input\.data\.filterJson\)/);
    assert.match(post, /const named = asked\.filter\.listId;/);
    assert.ok(
      post.indexOf("exportFilter(input.data.filterJson)") < post.indexOf("prisma.leadList.count"),
      "a value the reader cannot act on is refused by name before anything queries",
    );
  });

  it('guards on `typeof named === "string"`, not on truthiness', () => {
    // `if (named)` is the one-character version of a widening bug, and absent/`null` have to stay
    // no-opinion: a filter that says nothing about the crowd means the whole workspace, which is
    // what that caller asked for.
    assert.match(post, /if \(typeof named === "string"\)/);
    assert.doesNotMatch(post, /if \(named\)/);
  });

  it("looks the id up in this workspace's lists and nowhere else", () => {
    assert.match(
      post,
      /prisma\.leadList\.count\(\s*\{\s*where: \{\s*workspaceId, id: named\s*\}\s*\}\s*\)/,
      "unscoped, another tenant's list would resolve and the export would read rows it never names",
    );
  });

  it("refuses by name before the export row or its job is written", () => {
    const create = post.indexOf("prisma.export.create");
    assert.ok(create > 0, "the scanner lost the write it is ordering against");
    const refusalAt = post.indexOf("unknownIdError(EXPORT_LIST_ID, named)");
    assert.ok(refusalAt >= 0, "the refusal this rule added");
    assert.ok(refusalAt < create, "a stored row is a row the caller has to delete");
    assert.ok(post.indexOf('unknownIdError("profileId", input.data.profileId)') < create);
    assert.ok(post.indexOf("exportFilter(input.data.filterJson)") < create);
    assert.ok(post.indexOf("validateBody(body, EXPORT_CREATE)") < create);
  });

  it("files the filter it judged rather than the bytes it was handed", () => {
    // The other half of the padding decision: a trimmed name used only for the lookup would leave
    // the stored row naming one crowd while the worker matched another.
    assert.equal((post.match(/filterJson: declared/g) ?? []).length, 2, "the Export row and the Job config");
    assert.doesNotMatch(post, /filterJson: input\.data\.filterJson/, "the raw blob is not stored anywhere");
    assert.match(post, /\.\.\.\(declared === undefined \? \{\} : \{ filterJson: declared \}\)/);
  });

  it("is not the worker's job", () => {
    // Deliberately narrow: `exporter.ts` still matches whatever the stored row says, so an Export
    // filed before this rule shipped keeps delivering the empty file it always would have. The fix
    // is at the boundary, and the A/B press records the stored row's behaviour.
    const worker = blankComments(at("../../src/lib/exporter.ts"));
    assert.match(worker, /const filter = readExportFilter\(config\.filterJson\);/);
    assert.match(worker, /listMemberships = \{ some: \{ listId: filter\.listId \} \}/);
    assert.doesNotMatch(worker, /config\.filterJson\.listId/, "the worker goes through the reader, never past it");
  });
});

describe("the refusal is the sentence this app already says", () => {
  it("is a 422 naming the field, echoing the id, and carrying the machine-readable list", async () => {
    const { status, json } = await refusal(EXPORT_LIST_ID, "nope");
    assert.equal(status, 422);
    assert.equal(json.error, "filterJson.listId is not an id this workspace has: nope");
    assert.deepEqual(json.unknownIds, ["nope"]);
  });

  it("says the same thing about the press that looked least like a typo", async () => {
    // Another tenant's name, which is the one refusal that must not reveal who owns the row.
    const foreign = await refusal(EXPORT_LIST_ID, "cmListBeta");
    assert.equal(foreign.status, 422);
    assert.deepEqual(foreign.json.unknownIds, ["cmListBeta"]);
    assert.doesNotMatch(foreign.json.error, /other tenant|belongs to/i, "the door cannot say whose row it is");
  });

  it("spends the name from one spelling, not three", () => {
    // `filterJson.listId` is written by the reader's refusals, by the door's 422 and by the
    // contract; a fourth hand typing it is how the sentence and the key drift apart.
    assert.equal(EXPORT_LIST_ID, "filterJson.listId");
    assert.equal(EXPORT_LIST_ID, `filterJson.${EXPORT_FILTER_KEYS[3]}`);
  });

  it("is byte-identical to what the query-string door gives for the same id", async () => {
    // `GET /api/leads?listId=` reaches the same response through `idFilterParam`, so one client
    // handles the typo in a body and the typo in a URL without branching.
    const here = await refusal(EXPORT_LIST_ID, "nope");
    assert.equal(here.status, 422);
    assert.match(here.json.error, /^filterJson\.listId is not an id this workspace has: /);
    const query = await (unknownIdError("listId", "nope").json() as Promise<{ unknownIds: string[] }>);
    assert.deepEqual(query.unknownIds, here.json.unknownIds);
  });
});

describe("the contract says so", () => {
  const operation = openapiOperations.find((entry) => entry.operation.id === "exports.create")!;

  /** A body property's documented sentence, refused rather than skipped when absent. */
  function described(key: string): string {
    const body = operation.operation.body as { properties?: Record<string, { description?: string }> } | undefined;
    const text = body?.properties?.[key]?.description;
    assert.equal(typeof text, "string", `exports.create documents no description for \`${key}\``);
    return text as string;
  }

  it("documents that a `filterJson.listId` has to name a list, and what padding costs", () => {
    // RETARGETED from the `matched verbatim` promise, which described the half of #64 that did not
    // land. Main's sentence promises the opposite, and says it in three parts.
    const text = described("filterJson");
    assert.match(text, /A `listId` here names one of your lists/);
    assert.match(text, /padding is not part of the id/);
    assert.match(text, /an empty string is not a name/);
    assert.match(text, /a list this workspace does not have is refused at the door/);
  });

  it("prices the 422 for both ids and leaves the 400 to the filter's words", () => {
    const responses = operation.operation.responses as Record<string, string>;
    assert.match(responses["422"], /`profileId`, or the `listId` inside `filterJson`/);
    assert.match(responses["422"], /GET \/api\/leads\?listId=/);
    assert.doesNotMatch(responses["400"], /profileId/, "the body's unresolvable profile was never a 400 — measured 422");
    assert.match(responses["400"], /`filterJson` that names a crowd no Lead column can hold/);
  });

  it("still lists every filter key the reader knows", () => {
    const text = described("filterJson");
    for (const key of EXPORT_FILTER_KEYS) assert.ok(text.includes(key), `${key} missing from the description`);
  });
});

describe("the census: a body key that names a row is resolved by the door that takes it", () => {
  interface Entry {
    table: string;
    name: string;
    door: string;
    handler: string;
    model: string;
    refusal: RegExp;
    /** The write this reference guards — the one in the same branch, not the handler's first. */
    write: RegExp;
  }

  const doors: Entry[] = [
    {
      table: "EXPORT_CREATE",
      name: "profileId",
      door: "../../src/app/api/exports/route.ts",
      handler: "POST_impl",
      model: "exportProfile",
      refusal: /unknownIdError\("profileId", input\.data\.profileId\)/,
      write: /prisma\.export\.create\(/,
    },
    {
      table: "JOB_CREATE",
      name: "sourceId",
      door: "../../src/app/api/jobs/route.ts",
      handler: "POST_impl",
      model: "source",
      refusal: /unknownIdError\("sourceId", input\.data\.sourceId\)/,
      write: /prisma\.job\.create\(/,
    },
    {
      table: "LEAD_ADD_TO_LIST",
      name: "listId",
      door: "../../src/app/api/leads/[id]/route.ts",
      handler: "POST_impl",
      model: "leadList",
      refusal: /await assertOwns\(request, list\.workspaceId\)/,
      write: /prisma\.leadListMember\.create\(/,
    },
  ];

  /** Every `text` key ending in `Id` in every schema table this module exports. */
  function idShapedKeys(): [string, string][] {
    const found: [string, string][] = [];
    for (const [exported, value] of Object.entries(FIELD_TABLES)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      for (const [field, spec] of Object.entries(value as Record<string, { kind?: string }>)) {
        if (spec?.kind === "text" && /Id$/.test(field)) found.push([exported, field]);
      }
    }
    return found;
  }

  it("finds exactly the three row references this app takes in a body", () => {
    const found = idShapedKeys().map(([table, field]) => `${table}.${field}`).sort();
    assert.deepEqual(found, ["EXPORT_CREATE.profileId", "JOB_CREATE.sourceId", "LEAD_ADD_TO_LIST.listId"]);
  });

  it("resolves each one, against the right table, before the write", () => {
    for (const door of doors) {
      const body = blankComments(functionBody(at(door.door), door.handler)!);
      assert.match(
        body,
        new RegExp(`prisma\\.${door.model}\\.(findMany|findUnique)\\(`),
        `${door.table}.${door.name} was never looked up in ${door.model}`,
      );
      assert.match(body, door.refusal, `${door.table}.${door.name} has no refusal`);
      const write = body.search(door.write);
      assert.ok(write >= 0, `${door.door} has no ${String(door.write)} to order against`);
      assert.ok(body.search(door.refusal) < write, `${door.table}.${door.name} is checked after the row exists`);
      assert.ok(body.search(new RegExp(`prisma\\.${door.model}\\.(findMany|findUnique)\\(`)) < write);
    }
  });

  it("finds one nested id, and the door that takes it resolves it", () => {
    // A reference can also hide inside a `kind: "json"` body key — the list below is every one this
    // app takes, measured from the field tables rather than remembered. Two of them are read
    // through a declared vocabulary: an export's `filterJson` (`EXPORT_FILTER_KEYS`) and a rule's
    // `conditions` or a dynamic list's `filterJson` (`CONDITION_KEYS`, which `readListFilter` shares
    // with the rules). Only the export's vocabulary names a row, and `POST /api/exports` resolves
    // it. The rest carry no id-shaped key at all: `scraper.ts` and `scheduler.ts` spell `sourceId`
    // and `profileId` as columns of the rows they write, never as words read from a body.
    const jsonKeys = Object.entries(FIELD_TABLES)
      .filter(([, value]) => typeof value === "object" && value !== null && !Array.isArray(value))
      .flatMap(([table, spec]) =>
        Object.entries(spec as Record<string, { kind?: string }>)
          .filter(([, field]) => field.kind === "json")
          .map(([field]) => `${table}.${field}`),
      )
      .sort();
    assert.deepEqual(jsonKeys, [
      "EXPORT_CREATE.filterJson",
      "JOB_CREATE.config",
      "JOB_PATCH.config",
      "LEAD_CREATE.customFields",
      "LEAD_CREATE.socialProfiles",
      "LEAD_LIST_CREATE.filterJson",
      "LEAD_LIST_PATCH.filterJson",
      "LEAD_PATCH.customFields",
      "LEAD_PATCH.socialProfiles",
      "RULE_CREATE.actions",
      "RULE_CREATE.conditions",
      "RULE_PATCH.actions",
      "RULE_PATCH.conditions",
      "SOURCE_CREATE.config",
      "SOURCE_PATCH.config",
    ]);

    const nestedNamed = [
      ...EXPORT_FILTER_KEYS.filter((key) => /Id$/.test(String(key))).map((key) => `EXPORT_CREATE.filterJson.${key}`),
      ...CONDITION_KEYS.filter((key) => /Id$/.test(String(key))).map((key) => `conditions.${key}`),
    ];
    assert.deepEqual(nestedNamed, ["EXPORT_CREATE.filterJson.listId"]);
    assert.match(post, /unknownIdError\(EXPORT_LIST_ID, named\)/);
  });
});
