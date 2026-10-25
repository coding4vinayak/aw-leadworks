// #54 — three doors printed the signing secret, and no door could change it.
//
// Measured against `main` (65bd942) built in this round's own worktree and served on
// :3341 over `leadworks_r54` (`/tmp/opencode/r54_measure.log`, appendix
// `/tmp/opencode/r54_base_appendix.md`):
//
//   POST /api/webhooks                          201  secret = edbfd23a… (64 chars)
//   GET  /api/webhooks                          200  299B  plaintext secret in body: true
//   GET  /api/webhooks/{id}                     200  285B  plaintext secret in body: true
//   PATCH /api/webhooks/{id} {isActive:false}   200  285B  plaintext secret in body: true
//   three reads in a row                        200  one distinct value, equal to the created one
//   PATCH /api/webhooks/{id} {secret:"0"×64}    400  {"error":"no field to update was sent"}
//   PATCH … {isActive:true,secret:"2"×64}       200  the caller's value ignored, the row's printed
//   GET  /api/webhooks with six subscriptions   200 1734B  secrets printed: 6
//   GET  /api/webhooks with no key              401
//   GET  /api/webhooks with another tenant's key 200 15B (its own empty list)
//   GET/PATCH /api/webhooks/{foreign id}        404
//
// So the exposure is bounded to the tenant's own keys — an earlier round fixed the
// anonymous read, and this file keeps that fact pinned rather than re-litigating it.
// What is left is this: the secret is the HMAC key for deliveries, nothing in this
// product verifies one (`X-Leadworks-Signature` appears only on the sending side, at
// `src/lib/webhooks.ts:89` and `:95`), so a caller holding it is not inside LeadWorks —
// it can stand in front of LeadWorks to the subscriber. And the credential could not be
// retired: it is not an input anywhere, so the only replacement was `DELETE` + `POST`,
// while every press re-printed the old one.
//
// The product already has the rule, twice: `src/lib/apikeys.ts` ("The plaintext is
// returned once and never persisted") and the terms page ("Plaintext keys are shown
// once"). A key can honour it because verification needs only its digest. A signing
// secret cannot be stored as a digest — the sender HMACs with the value — so the only
// thing this round can decide is which door says it out loud. That is `WEBHOOK_READ_COLUMNS`:
// the whole row, by name, minus the credential.
//
// Nothing here needs a browser, a database, a disk or a network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import {
  WEBHOOK_CREATE,
  WEBHOOK_PATCH,
  WEBHOOK_READ_COLUMNS,
  webhookReadSelect,
} from "../../src/lib/fields";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const collectionRoute = blankComments(at("../../src/app/api/webhooks/route.ts"));
const detailRoute = blankComments(at("../../src/app/api/webhooks/[id]/route.ts"));
const sender = at("../../src/lib/webhooks.ts");
const schema = at("../../prisma/schema.prisma");
const readme = at("../../README.md");

/** The columns `model Webhook` actually has, read out of the schema itself. */
function webhookColumns(): string[] {
  const start = schema.indexOf("model Webhook {");
  assert.ok(start >= 0, "the schema still declares model Webhook");
  const block = schema.slice(start, schema.indexOf("\n}", start));
  return block
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^\w+\s+\w+/.test(line) && !line.startsWith("@@") && !line.startsWith("//"))
    .filter((line) => !/\s+\w+\[\]|\s+Workspace\b/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

describe("#54 the projection is the row, named, minus its credential", () => {
  it("withholds exactly the signing secret", () => {
    assert.ok(!WEBHOOK_READ_COLUMNS.includes("secret" as never), "the read projection names no secret");
  });

  it("is a census over `model Webhook`, not a subtraction from a memory", () => {
    const columns = webhookColumns();
    const withheld = columns.filter((column) => !WEBHOOK_READ_COLUMNS.includes(column as never));
    assert.deepEqual(
      withheld,
      ["secret"],
      `every column the model has is printed except the credential; the model holds ${columns.join(", ")}`,
    );
    for (const named of WEBHOOK_READ_COLUMNS) {
      assert.ok(columns.includes(named), `${named} is a column of the model, not a name invented here`);
    }
  });

  it("builds the Prisma select from those names and nothing else", () => {
    const select = webhookReadSelect();
    assert.deepEqual(Object.keys(select).sort(), [...WEBHOOK_READ_COLUMNS].sort());
    for (const [column, on] of Object.entries(select)) {
      assert.equal(on, true, `${column} is selected, not excluded by a false`);
    }
    assert.ok(!("secret" in select), "the select cannot gain a secret through the back of an object");
  });

  it("hands each door its own object", () => {
    const first = webhookReadSelect();
    delete (first as Record<string, unknown>).workspaceId;
    assert.ok("workspaceId" in webhookReadSelect(), "one door mutating its copy does not disarm the next");
  });

  it("agrees with the input tables, which never accepted it either", () => {
    for (const table of [WEBHOOK_CREATE, WEBHOOK_PATCH]) {
      assert.ok(!("secret" in table), "the secret is not an input, which is why nothing could rotate it");
    }
  });
});

describe("#54 the three read doors pass it", () => {
  it("the collection read selects the projection", () => {
    const body = functionBody(collectionRoute, "GET_impl") ?? "";
    assert.match(body, /prisma\.webhook\.findMany\(\s*\{[\s\S]*?select:\s*webhookReadSelect\(\)/);
  });

  it("the single read selects it", () => {
    const body = functionBody(detailRoute, "GET_impl") ?? "";
    assert.match(body, /prisma\.webhook\.findUnique\(\s*\{\s*where:\s*\{\s*id\s*\},\s*select:\s*webhookReadSelect\(\)/);
  });

  it("and the write's answer selects it, because an unrelated PATCH printed the credential", () => {
    const body = functionBody(detailRoute, "PATCH_impl") ?? "";
    assert.match(body, /prisma\.webhook\.update\(\s*\{\s*where:\s*\{\s*id\s*\},\s*data,\s*select:\s*webhookReadSelect\(\)/);
  });

  it("both files import the one list, so a door cannot invent its own columns", () => {
    for (const src of [collectionRoute, detailRoute]) {
      assert.match(src, /import\s*\{[^}]*webhookReadSelect[^}]*\}\s*from\s*"@\/lib\/fields"/);
    }
  });

  it("censuses every call the doors make on the table and knows what each one prints", () => {
    const WINDOW = 240;
    const sites = (src: string, method: string) => {
      const needle = `prisma.webhook.${method}(`;
      const found: string[] = [];
      for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + needle.length)) {
        found.push(src.slice(i, i + WINDOW));
      }
      return found;
    };
    const both = (method: string) => [...sites(collectionRoute, method), ...sites(detailRoute, method)];
    assert.equal(
      ["findMany", "findUnique", "update", "delete", "create"].map((m) => `${m}:${both(m).length}`).join(" "),
      "findMany:1 findUnique:3 update:1 delete:1 create:1",
      "seven calls in two files; a new one has to be named here before it can hand a row to a caller",
    );

    assert.equal(both("findMany").filter((c) => /select:\s*webhookReadSelect\(\)/.test(c)).length, 1, "the list read is projected");
    assert.equal(both("update").filter((c) => /select:\s*webhookReadSelect\(\)/.test(c)).length, 1, "the PATCH answer is projected");
    const reads = both("findUnique");
    assert.equal(reads.filter((c) => /select:\s*webhookReadSelect\(\)/.test(c)).length, 1, "one by-id read is projected");
    assert.equal(
      reads.filter((c) => /select:\s*\{\s*workspaceId:\s*true\s*\}/.test(c)).length,
      2,
      "two are the ownership probes, which already asked for one column",
    );
    assert.equal(
      reads.filter((c) => !/select:/.test(c)).length,
      0,
      "and no read on this table goes unprojected",
    );

    const lines = (src: string, method: string) =>
      src.split("\n").filter((line) => line.includes(`prisma.webhook.${method}(`));
    for (const line of [...lines(collectionRoute, "delete"), ...lines(detailRoute, "delete")]) {
      assert.match(
        line,
        /^\s*await prisma\.webhook\.delete\(/,
        `the deleted row is never bound, so nothing can print it: ${line.trim()}`,
      );
    }

    assert.equal(both("create").length, 1, "the mint stands alone");
    assert.ok(!/select:/.test(both("create")[0]), "and it reads the whole row back");
    const createBody = functionBody(collectionRoute, "POST_impl") ?? "";
    assert.ok(!/select:/.test(createBody), "the create door is the one call with no select, because its answer must carry the secret");
  });

  it("still answers 201 with the created row, secret included", () => {
    const body = functionBody(collectionRoute, "POST_impl") ?? "";
    assert.match(body, /return NextResponse\.json\(webhook,\s*\{\s*status:\s*201\s*\}\)/);
  });

  it("keeps the ownership check able to run", () => {
    assert.ok(WEBHOOK_READ_COLUMNS.includes("workspaceId"), "the by-id door asserts on the column it projects");
    const body = functionBody(detailRoute, "GET_impl") ?? "";
    assert.match(body, /assertOwns\(request,\s*webhook\.workspaceId\)/);
  });

  it("keeps DELETE's answer as the one this product already documented", () => {
    const body = functionBody(detailRoute, "DELETE_impl") ?? "";
    assert.match(body, /NextResponse\.json\(\s*\{\s*ok:\s*true\s*\}\s*\)/);
  });

  it("offers no way to ask for it back", () => {
    // A projection the caller names could be pointed at `secret`; these doors read no
    // such parameter, so the refusal is structural rather than a filter to maintain.
    for (const src of [collectionRoute, detailRoute]) {
      assert.doesNotMatch(src, /searchParams\.get\(\s*"fields"/, "no field pick on a webhook door");
    }
  });
});

describe("#54 the secret still reaches what signs with it", () => {
  it("the sender reads the column from the table, not from a door", () => {
    assert.match(sender, /hook\.secret/, "delivery HMACs with the stored value");
    assert.match(sender, /prisma\.webhook\.findMany\(/, "and gets it by asking for the subscriptions");
  });

  it("no route file reads a signing secret off a row at all", () => {
    const files: Record<string, string> = { "webhooks/route.ts": collectionRoute, "webhooks/[id]/route.ts": detailRoute };
    const offenders = Object.entries(files)
      .map(([name, src]) => [name, src.replace(/const secret = crypto\.randomBytes\(32\)\.toString\("hex"\);/, "")] as const)
      .filter(([, code]) => /\.secret\b/.test(code) || /\bsecret:/.test(code))
      .map(([name]) => name);
    assert.deepEqual(offenders, [], "the only `secret` in a door is the one it just minted");
  });

  it("nothing in this product verifies an inbound webhook signature", () => {
    // Why the leak was "forge a delivery into someone else's subscriber" and not
    // "get inside LeadWorks": the only HMAC in these files signs an outgoing body.
    // If a verifier ever lands, this pin is the signal to re-read the measurement
    // above before deciding what any door may print.
    const routes = at("../../src/app/api/webhooks/route.ts") + at("../../src/app/api/webhooks/[id]/route.ts");
    assert.ok(!/createHmac|timingSafeEqual/.test(blankComments(routes)), "no door here recomputes a digest to compare");
    assert.equal(
      (blankComments(sender).match(/createHmac/g) ?? []).length,
      1,
      "the one HMAC in the webhook code is the sender's",
    );
    assert.equal(
      ["X-Leadworks-Signature", "X-Webhook-Signature"].filter((header) => sender.includes(header)).length,
      2,
      "and both spellings of it travel as outbound headers",
    );
  });
});

describe("#54 the rule is written where a caller would read it", () => {
  it("the README names the create door as the only one that prints it", () => {
    assert.match(readme, /answers `201`\nwith the created subscription and its `secret` — the one door that prints that/);
  });

  it("and says how a lost secret is replaced", () => {
    assert.match(readme, /A secret lost is replaced by\n`DELETE` then `POST` — a new row, a new id, a new secret/);
  });

  it("and the API list does not promise the credential on a read", () => {
    const line = readme.split("\n").find((row) => row.startsWith("GET    /api/webhooks?workspaceId=")) ?? "";
    assert.match(line, /not their signing/, "the list says what the door no longer prints");
  });

  it("appeals to the product's own words, which are still there", () => {
    const apikeys = at("../../src/lib/apikeys.ts");
    assert.match(apikeys, /The plaintext is returned once and never persisted/);
    const terms = at("../../src/app/terms/page.tsx");
    assert.match(terms, /Plaintext keys are shown once/);
  });

  it("and keeps the two lists in one screen, which is why fields.ts holds them", () => {
    const fields = at("../../src/lib/fields.ts");
    assert.match(fields, /`Webhook\.secret`\. Accepting one of those from a/, "the input half still says never");
    assert.match(fields, /One output list lives here too, `WEBHOOK_READ_COLUMNS`/, "and the output half says where");
  });
});
