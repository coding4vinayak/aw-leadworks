/**
 * #73 — the map promised a credential the doors had stopped printing.
 *
 * `5ac46e3` (#54) took `Webhook.secret` off every read door and wrote the rule into
 * `WEBHOOK_READ_COLUMNS`, the two routes' comments and this README's API list. What it
 * did not touch is the sentence an integrator reads first: `src/lib/openapi.ts` went on
 * calling `GET /api/webhooks` *"The outbound subscriptions, with their signing secret
 * previewed"*, and `public/llms-full.txt` is generated from that file, so the same stale
 * promise was answering at three addresses — `/api/openapi`, `/openapi.json` and the
 * deep-content file an agent is pointed at — none of which asks for a key.
 *
 * Measured on `ff38306` before anything was written (`:3433` over this session's own
 * `leadworks_r73`, `wh_r73_a` in tenant A and `wh_r73_b` in tenant B, keys in `0600`
 * files printed nowhere; `/tmp/opencode/r73_press_ab.log`, legs re-taken on the fix
 * build at `:3434` over the same two rows):
 *
 *   GET /api/openapi     200 73,195 B sha=319930bc8c49  webhooks.list.summary=…previewed
 *   GET /openapi.json    200 73,195 B sha=319930bc8c49  the same document, byte-identical
 *   GET /llms-full.txt   200  8,447 B sha=f50b5e034596  line 96 quotes the same sentence
 *   POST /api/webhooks   201  keys include `secret`, 64 characters
 *   GET /api/webhooks    200    434 B  rows=2  secret printed=0  matches the column=0
 *   GET /api/webhooks/{id}       204 B  rows=1  sha=18ca1b5b27a6  secret printed=0
 *   PATCH {isActive:false}       215 B  rows=1  secret printed=0  matches the column=0
 *   PATCH {secret:"0"×64}        400 "no field to update was sent"
 *   DELETE the row the press minted → the list reads back 2a16fe56c0f3, byte-identical
 *
 * On the fix build the same press answers 73,241 B / sha=28da556aa53f for both contract
 * paths and 8,493 B / sha=6f71b07e1fa5 for the deep-content file, and every door leg
 * above the same bytes it answered before.
 *
 * So the promise was false in the one direction that costs something: the credential a
 * subscriber verifies deliveries with, advertised as readable on a list. A caller who
 * lost a secret and believed the map polls a door that never answers; a reviewer who
 * trusts the map believes three read doors leak what the code goes out of its way to
 * withhold. The fix is the sentence, not the behaviour — the behaviour was already right
 * and every leg above still measures the same bytes.
 *
 * Nothing here needs a network, a database or a browser.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankComments } from "./route-handlers";
import { openapiOperations, openapiSpec } from "../../src/lib/openapi";
import { WEBHOOK_READ_COLUMNS } from "../../src/lib/fields";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const contract = blankComments(at("../../src/lib/openapi.ts"));
const full = at("../../public/llms-full.txt");
const readme = at("../../README.md");
const schema = at("../../prisma/schema.prisma");

const STALE = "The outbound subscriptions, with their signing secret previewed.";

/** The operation the contract answers for one door, by its stable id. */
function op(id: string) {
  const found = openapiOperations.find((entry) => entry.operation.id === id);
  assert.ok(found, `${id} is still an operation in the contract`);
  return found!.operation;
}

/** Every credential-bearing word a response could promise. */
const CREDENTIAL = /secret|token|plaintext|password|credential/i;

describe("#73 the list door's summary is the row the door answers", () => {
  it("no longer promises the credential on a read", () => {
    assert.ok(!contract.includes(STALE), "the stale sentence is gone from the contract source");
    assert.doesNotMatch(contract, /previewed/i, "and nothing else in that file previews a secret either");
    assert.ok(!full.includes(STALE), "the generated deep-content file moved with it");
  });

  it("says what is withheld, and where the credential does appear", () => {
    const summary = op("webhooks.list").summary;
    assert.match(summary, /every column of the row but its signing secret/);
    assert.match(summary, /the create door prints once/);
    assert.ok(!CREDENTIAL.test(`${summary}`.replace(/signing secret/g, "")), "no other credential word sneaks into the sentence");
  });

  it("and that sentence is true of the projection the doors pass", () => {
    // The map now describes a named list rather than a hope: what it calls "every column
    // of the row but its signing secret" is `WEBHOOK_READ_COLUMNS`, and the column it
    // withholds is the one `model Webhook` declares.
    assert.ok(!WEBHOOK_READ_COLUMNS.includes("secret" as never), "the projection names no credential");
    const block = schema.slice(schema.indexOf("model Webhook {"), schema.indexOf("\n}", schema.indexOf("model Webhook {")));
    const columns = block
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && !name.startsWith("@@") && name !== "workspace" && name !== "deliveries");
    assert.deepEqual(
      columns.filter((column) => !WEBHOOK_READ_COLUMNS.includes(column as never)),
      ["secret"],
      "the row the map describes is the model minus the credential, with nothing else missing",
    );
  });

  it("offers no way to ask for it back, in the map or at the door", () => {
    for (const id of ["webhooks.list", "webhooks.get", "webhooks.update"]) {
      const operation = op(id);
      const named = (operation.query ?? []).map(([name]) => name);
      assert.ok(
        !named.some((name) => /fields|select|include|secret/i.test(name)),
        `${id} advertises no parameter that could name a credential: ${named.join(", ") || "(no query)"}`,
      );
      assert.ok(!CREDENTIAL.test(Object.values(operation.responses ?? {}).join(" ")), `${id}' responses promise no credential`);
    }
  });
});

describe("#73 the census: which sentences in the map may name a credential", () => {
  it("exactly two, and one of them is the door that mints it", () => {
    const named = openapiOperations
      .filter(({ operation }) => {
        const text = [operation.summary, ...Object.values(operation.responses ?? {})].join(" ");
        return CREDENTIAL.test(text);
      })
      .map(({ method, path, operation }) => `${method.toUpperCase()} ${path} ${operation.id}`);
    assert.deepEqual(
      named,
      ["GET /api/webhooks webhooks.list", "POST /api/webhooks webhooks.create"],
      "the list door may name the secret only to withhold it, and the create door only to say it comes once",
    );
  });

  it("the create door's sentence is the truth this product ships", () => {
    assert.match((op("webhooks.create").responses ?? {})["201"] ?? "", /signing secret returned once/);
    const declared = Object.keys(op("webhooks.create").body?.properties ?? {}).sort();
    assert.deepEqual(declared, ["events", "url"], "the request body names an address and events, never a credential");
  });

  it("no read in the whole contract says a credential comes back", () => {
    const offenders = openapiOperations
      .filter(({ method }) => method !== "post")
      .filter(({ operation }) => {
        const text = [operation.summary, ...Object.values(operation.responses ?? {})].join(" ");
        return /secret|token|plaintext|credential/.test(text) && !/but its signing secret|prints once|no credential|without/.test(text);
      })
      .map(({ path, operation }) => `${path} ${operation.id}`);
    assert.deepEqual(offenders, [], "a GET/PATCH/DELETE sentence that hands over a credential is the shape this round removed");
  });

  it("the served document agrees with the table it is generated from", () => {
    // `/api/openapi` and `/openapi.json` both serve `openapiSpec`, so the pin that matters
    // is that the built document carries the corrected sentence and not the old one.
    const served = openapiSpec.paths["/api/webhooks"]?.get as { summary?: string } | undefined;
    assert.equal(served?.summary, op("webhooks.list").summary, "the served summary is the table's");
    assert.ok(served && !served.summary!.includes("previewed"), "and it no longer promises a preview");
  });
});

describe("#73 the rule is written where a caller or an agent reads it", () => {
  it("the deep-content file quotes the corrected line and nothing else", () => {
    const line = full.split("\n").find((row) => row.includes("`GET /api/webhooks`")) ?? "";
    assert.match(line, /every column of the row but its signing secret/);
    assert.ok(!line.includes("previewed"), line);
  });

  it("the README keeps the API list honest about the read", () => {
    const line = readme.split("\n").find((row) => row.startsWith("GET    /api/webhooks?workspaceId=")) ?? "";
    assert.match(line, /not their signing/);
  });

  it("the round is written down with the bytes it measured", () => {
    // Whitespace-flexible: README wraps at ~78 columns and a re-wrap is not a retraction.
    assert.match(readme, /with their signing secret\s+previewed/);
    assert.match(readme, /generated from it by `scripts\/build-llms-full\.mts`/);
    assert.match(readme, /73,195 → 73,241 bytes/);
    assert.match(readme, /8,447 → 8,493/);
    assert.match(readme, /The\s+summary\s+is\s+the\s+row\s+now/);
    assert.match(readme, /sequential, not simultaneous/);
  });

  it("and the older narrative no longer says a read prints the credential", () => {
    assert.ok(!/`GET \/api\/webhooks\/\{id\}` afterwards prints the row/.test(readme), "present tense retired");
    assert.match(readme, /printed the row as that\s+build held it/);
    assert.match(readme, /`5ac46e3`\s+took\s+off\s+every\s+read\s+door/);
  });
});
