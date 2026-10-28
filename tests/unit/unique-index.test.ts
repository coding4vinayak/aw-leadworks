// A unique violation reaches the caller through one function, and until this
// round that function could not read what Prisma 7 told it.
//
// Measured on a live instance (aw-leadworks at `e3fcc16`, built, booted on
// :3418 over its own database `leadworks_r67`, presses in
// `/tmp/opencode/r67_press_base.log`). What a duplicate lead's error carries,
// read off the error itself (`/tmp/opencode/r67-meta-probe.log`) — and the
// `Workspace_slug_key` and `LeadListMember_listId_leadId_key` errors carry the
// same shape with the same keys, only the names change:
//
//   {"driverAdapterError":{"name":"DriverAdapterError","cause":
//     {"originalCode":"23505",
//      "originalMessage":"duplicate key value violates unique constraint \"Lead_workspaceId_email_key\"",
//      "kind":"UniqueConstraintViolation","constraint":{"index":"Lead_workspaceId_email_key"},
//      "table":"Lead"}},"modelName":"Lead"}
//
// — there is no `meta.target`, which is the only field `conflictFor` read. So
// five doors answered a collision without naming what collided:
//
//   press                                          base build
//   POST /api/leads  {"email":"john@x.com"} twice  409 {"error":"That Lead already exists in this
//                                                            workspace.","conflict":{"fields":[]}}
//   PATCH /api/leads/{nina} {"email":"john@x.com"} 409  same, fields []
//   POST /api/lead-lists/{l}?action=add-leads twice 409 "That LeadListMember already exists…"
//   POST …?action=add-leads {"leadIds":[john,john]} 409  same, fields []
//   POST /api/leads/{john}?action=add-to-list again  409  same, fields []
//
// `conflict.fields` is the one part of that body a client can act on — it is
// what marks an input box red. `[]` marks nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conflictFor } from "../../src/lib/apikeys";
import { uniqueIndexColumns, uniqueViolationColumns } from "../../src/lib/unique-index";

const ROOT = join(import.meta.dirname!, "..", "..");
const fromRoot = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The error shape a door is handed, built from the live meta above. */
function prismaP2002(meta?: unknown): Error & { code: string; meta?: unknown } {
  const error = new Error("Unique constraint failed") as Error & { code: string; meta?: unknown };
  error.name = "PrismaClientKnownRequestError";
  error.code = "P2002";
  if (meta !== undefined) error.meta = meta;
  return error;
}

function adapterMeta(model: string, index: string): unknown {
  // The whole meta, as measured: Prisma 7 leaves `target` present and EMPTY, so
  // the door that reads only `target` has nothing to name.
  return {
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        originalMessage: `duplicate key value violates unique constraint "${index}"`,
        kind: "UniqueConstraintViolation",
        constraint: { index },
        table: model,
      },
    },
    modelName: model,
    target: [],
  };
}

describe("an index name says which columns it refused", () => {
  it("reads the three names measured against pg_indexes", () => {
    assert.deepEqual(uniqueIndexColumns("Lead_workspaceId_email_key", "Lead"), ["workspaceId", "email"]);
    assert.deepEqual(uniqueIndexColumns("LeadListMember_listId_leadId_key", "LeadListMember"), ["listId", "leadId"]);
    assert.deepEqual(uniqueIndexColumns("Workspace_slug_key", "Workspace"), ["slug"]);
  });

  it("keeps the order the index holds the columns in", () => {
    // The order is the schema's (`@@unique([listId, leadId])`), and a caller
    // reading two fields back wants them in the order it typed the pair.
    assert.deepEqual(uniqueIndexColumns("Membership_userId_workspaceId_key", "Membership"), ["userId", "workspaceId"]);
    assert.notDeepEqual(uniqueIndexColumns("Membership_userId_workspaceId_key", "Membership"), [
      "workspaceId",
      "userId",
    ]);
  });

  it("refuses to guess from a name that is not this table's key", () => {
    assert.equal(uniqueIndexColumns("Lead_workspaceId_email_pkey", "Lead"), null, "not a _key index");
    assert.equal(uniqueIndexColumns("OtherLead_workspaceId_email_key", "Lead"), null, "another table's index");
    assert.equal(uniqueIndexColumns("Lead_workspaceId__key", "Lead"), null, "an empty column slot");
    assert.equal(uniqueIndexColumns("Lead_workspaceId_email_key", ""), null, "no table to strip");
  });

  it("splits on the underscore, which is why the census below exists", () => {
    // A column named with an underscore in it would come apart here and no
    // amount of reading the name could put it back. That is not a runtime
    // problem to solve, it is a schema fact to prove.
    assert.deepEqual(uniqueIndexColumns("Lead_workspace_id_key", "Lead"), ["workspace", "id"]);
  });
});

describe("the meta Prisma 7 actually hands a door", () => {
  it("resolves columns and model from the driver adapter's constraint", () => {
    const violation = uniqueViolationColumns(prismaP2002(adapterMeta("Lead", "Lead_workspaceId_email_key")));
    assert.deepEqual(violation, { model: "Lead", columns: ["workspaceId", "email"] });
  });

  it("resolves the membership pair too, because five doors hit this path", () => {
    const violation = uniqueViolationColumns(prismaP2002(adapterMeta("LeadListMember", "LeadListMember_listId_leadId_key")));
    assert.deepEqual(violation?.columns, ["listId", "leadId"]);
  });

  it("says nothing when the meta is not a unique violation", () => {
    assert.equal(uniqueViolationColumns(prismaP2002({ driverAdapterError: { cause: { kind: "ForeignKeyViolation" } } })), null);
    assert.equal(uniqueViolationColumns(prismaP2002({ driverAdapterError: {} })), null);
    assert.equal(uniqueViolationColumns(prismaP2002({ modelName: "Lead" })), null);
    assert.equal(uniqueViolationColumns(prismaP2002()), null, "no meta at all");
    assert.equal(uniqueViolationColumns("P2002"), null, "not even an Error");
  });

  it("still reads meta.target first, which is what Prisma 5 and 6 gave", () => {
    // The old shape stays the authority when both are present: the target is
    // the client's own words about the constraint, the index name is Postgres'.
    const both = prismaP2002({
      ...(adapterMeta("Lead", "Lead_workspaceId_email_key") as object),
      target: ["email"],
    });
    assert.deepEqual(uniqueViolationColumns(both), { model: "Lead", columns: ["email"] });
    assert.deepEqual(uniqueViolationColumns(prismaP2002({ modelName: "Metric", target: "name" })), {
      model: "Metric",
      columns: ["name"],
    });
  });

  it("reads the index name when the target is there and empty, which is what this round measured", () => {
    // The live meta is `{ …, target: [] }` — present, so a check that only asks
    // whether `target` exists would answer "nothing collided" forever.
    assert.deepEqual(uniqueViolationColumns(prismaP2002({ modelName: "Lead", target: [] })), null,
      "an empty target with no constraint behind it names nothing");
    assert.deepEqual(uniqueViolationColumns(prismaP2002(adapterMeta("Lead", "Lead_workspaceId_email_key"))), {
      model: "Lead",
      columns: ["workspaceId", "email"],
    });
  });
});

describe("the 409 a caller gets", () => {
  it("names the column that collided, on the sentence the door already used", () => {
    const result = conflictFor(prismaP2002(adapterMeta("Lead", "Lead_workspaceId_email_key")));
    assert.equal(result?.status, 409);
    assert.deepEqual(result?.body.conflict, { fields: ["email"] });
    assert.equal(result?.body.error, "A Lead with this email already exists in this workspace.");
  });

  it("does not name the workspace the caller already authenticated as", () => {
    // Same rule the `meta.target` path has always had, now reached by the real
    // error: `workspaceId` is scope, not collision.
    const result = conflictFor(prismaP2002(adapterMeta("AnalyticsDaily", "AnalyticsDaily_workspaceId_date_key")));
    assert.deepEqual(result?.body.conflict, { fields: ["date"] });
    assert.doesNotMatch(String(result?.body.error), /workspaceId/);
  });

  it("joins both columns of a pair that holds no workspace", () => {
    const result = conflictFor(prismaP2002(adapterMeta("LeadListMember", "LeadListMember_listId_leadId_key")));
    assert.deepEqual(result?.body.conflict, { fields: ["listId", "leadId"] });
    assert.match(String(result?.body.error), /this listId \+ leadId/);
  });

  it("keeps the old sentence when the name does not decompose", () => {
    // A constraint someone renamed with `map:` is not a column list, and a
    // wrong field would mark the wrong input box red.
    const result = conflictFor(prismaP2002(adapterMeta("Lead", "lead_email_dupes")));
    assert.equal(result?.status, 409);
    assert.deepEqual(result?.body.conflict, { fields: [] });
    assert.equal(result?.body.error, "That Lead already exists in this workspace.");
  });

  it("carries no other tenant's data in the body", () => {
    const result = conflictFor(prismaP2002(adapterMeta("Lead", "Lead_workspaceId_email_key")));
    const body = JSON.stringify(result?.body);
    assert.doesNotMatch(body, /ws_r67_a|ws_r67_b/, "no workspace id leaks");
    assert.doesNotMatch(body, /originalMessage|driverAdapterError|23505/, "no driver internals leak");
  });

  it("leaves every other failure to the caller, as before", () => {
    const other = prismaP2002(adapterMeta("Lead", "Lead_workspaceId_email_key"));
    other.code = "P2003";
    assert.equal(conflictFor(other), null);
    assert.equal(conflictFor(new Error("Unique constraint failed")), null);
  });
});

describe("the schema is what makes the name readable", () => {
  /** Every unique constraint `prisma/schema.prisma` declares, as model + columns. */
  function declaredUniques(): { model: string; columns: string[] }[] {
    const schema = fromRoot("prisma/schema.prisma");
    const found: { model: string; columns: string[] }[] = [];
    for (const block of schema.split(/^model /m).slice(1)) {
      const model = block.slice(0, block.indexOf(" {")).trim();
      const body = block.slice(0, block.indexOf("\n}"));
      for (const line of body.split("\n")) {
        const single = line.match(/^\s*(\w+)\s+\S+\s+.*@unique/);
        if (single) found.push({ model, columns: [single[1]] });
        const composite = line.match(/@@unique\(\[([^\]]+)\]\)/);
        if (composite) {
          found.push({ model, columns: composite[1].split(",").map((c) => c.trim()).filter(Boolean) });
        }
      }
    }
    return found;
  }

  it("declares the fifteen constraints this round measured", () => {
    const names = declaredUniques()
      .map((u) => `${u.model}_${u.columns.join("_")}_key`)
      .sort();
    assert.deepEqual(names, [
      "AnalyticsDaily_workspaceId_date_key",
      "ApiKey_hashedKey_key",
      "EmailVerificationToken_tokenHash_key",
      "EmailVerificationToken_userId_key",
      "Invite_tokenHash_key",
      "LeadListMember_listId_leadId_key",
      "Lead_workspaceId_email_key",
      "Membership_userId_workspaceId_key",
      "PasswordResetToken_tokenHash_key",
      "Session_tokenHash_key",
      "Subscription_stripeCustomerId_key",
      "Subscription_stripeSubscriptionId_key",
      "Subscription_workspaceId_key",
      "User_email_key",
      "Workspace_slug_key",
    ]);
  });

  it("names every declared column so the split cannot come apart", () => {
    // The reader to prove for: a unique column spelled `home_town` would give
    // `Model_home_town_key`, and this module would call it two columns.
    for (const { model, columns } of declaredUniques()) {
      assert.doesNotMatch(model, /_/, `${model}: a model name with an underscore is not strippable`);
      for (const column of columns) {
        assert.doesNotMatch(column, /_/, `${model}.${column}: an underscore in a unique column breaks the split`);
        assert.match(column, /^[a-z][A-Za-z0-9]*$/, `${model}.${column}: not camelCase, so check the mapping`);
      }
    }
  });

  it("maps no name at all, so no list can fall behind the schema", () => {
    // `@map`/`@@map` would make a table or column differ from its Prisma name,
    // and then `Model_column_key` would be a guess rather than a fact.
    const schema = fromRoot("prisma/schema.prisma");
    assert.equal(schema.match(/@map\(/g)?.length ?? 0, 0, "a column mapped to another name");
    assert.equal(schema.match(/@@map\(/g)?.length ?? 0, 0, "a model mapped to another table");
    assert.equal(schema.match(/@@unique\([^)]*\)\s*@map/g)?.length ?? 0, 0, "a constraint with its own name");
  });

  it("resolves every declared constraint through the module", () => {
    for (const { model, columns } of declaredUniques()) {
      assert.deepEqual(uniqueIndexColumns(`${model}_${columns.join("_")}_key`, model), columns, model);
    }
  });

  it("is reached from the doors through exactly one translator", () => {
    // Five doors hit a unique index, and none of them decides the sentence.
    const users = fromRoot("src/lib/apikeys.ts");
    assert.match(users, /uniqueViolationColumns\(error\)/);
    for (const path of [
      "src/app/api/leads/route.ts",
      "src/app/api/leads/[id]/route.ts",
      "src/app/api/lead-lists/[id]/route.ts",
    ]) {
      assert.doesNotMatch(fromRoot(path), /uniqueViolationColumns|uniqueIndexColumns/, `${path} builds its own 409`);
    }
    // P2002 is named in one translator, in one place that deliberately swallows
    // it (a billing event that arrived twice), and in a comment.
    const grep = [
      "src/lib/apikeys.ts",
      "src/lib/billing-events.ts",
      "src/lib/ids.ts",
      "src/lib/unique-index.ts",
    ];
    for (const path of grep) assert.match(fromRoot(path), /P2002|23505|UniqueConstraintViolation/, `${path} changed shape`);
    const sources = fromRoot("src/lib/apikeys.ts") + fromRoot("src/lib/billing-events.ts");
    assert.ok(sources.includes("code !== \"P2002\""), "the two readers both key off the code");
  });
});
