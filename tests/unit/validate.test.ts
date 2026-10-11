// N5: a wrong-typed field used to be the database's problem, and the database
// answered one of two ways. Measured against this app's own dev.db, through the
// exported handlers, one body with exactly one wrong field each time
// (/tmp/abectorial/n5-lw-before.txt):
//
//   POST  /api/leads          email: 42              500 PrismaClientValidationError
//   POST  /api/leads          seniority: "BOSS"      201, and no status filter sees it
//   POST  /api/leads          firstName: 6000 chars  201
//   POST  /api/lead-lists     isDynamic: "yes"       201 with true stored — "no" too
//   POST  /api/sources        config: 42             201, a number in a Json column
//   POST  /api/jobs           type: "MOON"           201, a job no worker runs
//   POST  /api/exports        format: "PDFX"         201, and its job ends FAILED
//   POST  /api/webhooks       events: ["a.b","c.d"]  500 (the column is a String)
//   PATCH /api/jobs/:id       status: "DONE"         200, invisible to the retry guard
//   PATCH /api/leads/:id      {}                     200 holding an unchanged row
//   PATCH /api/sources/:id    name: ""               200, name unchanged
//   POST  any write route     no body at all         500 SyntaxError from request.json()
//
// These pin the engine's own contract, because every write route here is written
// against it. The route-level proof is the after-table in improvements §8.13.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  eventNames,
  NO_FIELD_TO_UPDATE,
  readJson,
  stringList,
  validateBody,
  type Schema,
} from "../../src/lib/validate";
import { EXPORT_CREATE, LEAD_CREATE, LEAD_PATCH } from "../../src/lib/fields";

const body = async (response: Response) =>
  (await response.json()) as { error: string; fields?: Record<string, string> };

const ONE = {
  name: { kind: "text", required: true, max: 20 },
  nickname: { kind: "text", nullable: true },
} satisfies Schema;

describe("a field the route did not declare is not a value it will write", () => {
  it("omits a key the body never mentioned, so PATCH cannot reset it", async () => {
    const result = validateBody({ name: "kept" }, ONE);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.data ?? {}), ["name"]);
    assert.equal("nickname" in (result.data ?? {}), false);
  });

  it("refuses a body that is not an object", async () => {
    for (const value of [null, 42, "name", ["a"]]) {
      const result = validateBody(value, ONE);
      assert.equal(result.ok, false, `${JSON.stringify(value)} should not pass`);
      assert.equal(result.error?.status, 400);
    }
  });

  it("names every field that is wrong, in one response", async () => {
    const result = validateBody({ name: 42, nickname: [] }, ONE);
    assert.equal(result.ok, false);
    const payload = await body(result.error!);
    assert.match(payload.error, /name must be text/);
    assert.match(payload.error, /nickname must be text/);
    assert.deepEqual(Object.keys(payload.fields ?? {}).sort(), ["name", "nickname"]);
  });

  it("never lets a caller write a column the table does not name", async () => {
    // `workspaceId` and `id` come from the key and the path. A body that brings
    // its own used to be spread into Prisma's `data` by every PATCH here.
    const result = validateBody({ name: "x", workspaceId: "other", status: "NEW" }, LEAD_CREATE);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.data ?? {}), ["name"].filter((k) => k in result.data!));
    assert.equal("workspaceId" in (result.data ?? {}), false);
    assert.equal("status" in (result.data ?? {}), false);
  });
});

describe("the request body itself", () => {
  const request = (payload: string | undefined, method = "POST") =>
    new Request("http://localhost/api/leads", {
      method,
      headers: { "content-type": "application/json" },
      body: payload,
    });

  it("is a 400 when it is not JSON, where `request.json()` was a 500", async () => {
    // Measured on POST /api/leads and POST /api/lead-lists: a malformed body
    // threw a SyntaxError inside the handler, which `withAuth` does not map.
    for (const payload of ["", "not json", "{", '{"email": "a@b.co",}']) {
      const parsed = await readJson(request(payload));
      assert.equal(parsed.ok, false, JSON.stringify(payload));
      assert.equal(parsed.error?.status, 400);
      assert.equal((await body(parsed.error!)).error, "request body is not valid JSON");
    }
  });

  it("hands the route what it parsed when it is", async () => {
    const parsed = await readJson(request('{"email":"a@b.co"}'));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.body, { email: "a@b.co" });
  });
});

describe("text", () => {
  it("trims, because a padded email defeats the unique index", async () => {
    const result = validateBody({ name: "  Ada  " }, ONE);
    assert.equal(result.ok && result.data.name, "Ada");
  });

  it("refuses blank for a NOT NULL column and clears it for a nullable one", async () => {
    // `PATCH {name:""}` measured as a 200 that renamed nothing: `&&` dropped the
    // key before Prisma ever saw it.
    assert.equal((await body(validateBody({ name: "   " }, ONE).error!)).error, "name must be a non-empty string");
    const cleared = validateBody({ name: "x", nickname: "  " }, ONE);
    assert.equal(cleared.ok && cleared.data.nickname, null);
  });

  it("says how long it was", async () => {
    const result = validateBody({ name: "n".repeat(21) }, ONE);
    assert.match((await body(result.error!)).error, /name is 21 characters; at most 20/);
  });

  it("checks shape, not deliverability", async () => {
    // Measured: `email: "not an address"` and `email: "a@b"` were both a 201,
    // and the second one is not mailable by anything.
    const email = { to: { kind: "text", format: "email" } } satisfies Schema;
    for (const good of ["a@b.co", "first.last@x.co.uk", "ada+lead@sub.example.com"]) {
      assert.equal(validateBody({ to: good }, email).ok, true, good);
    }
    for (const badValue of ["42", "a b@c.com", "a@", "a@b", "a,b@c.com"]) {
      assert.equal(validateBody({ to: badValue }, email).ok, false, `${badValue} is not an address`);
    }
  });

  it("refuses a URL that is not http(s)", async () => {
    // `webhooks.POST url:"javascript:alert(1)"` stored it, and `Webhook.url` is
    // the field the notifier would open.
    const link = { url: { kind: "text", format: "url" } } satisfies Schema;
    assert.equal(validateBody({ url: "https://x.test/h" }, link).ok, true);
    for (const badValue of ["javascript:alert(1)", "ftp://x.test", "mailto:a@b.co", "/relative"]) {
      assert.equal(validateBody({ url: badValue }, link).ok, false, badValue);
    }
  });
});

describe("numbers and booleans", () => {
  const counts = { n: { kind: "int" }, f: { kind: "number" }, b: { kind: "bool" } } satisfies Schema;

  it("refuses a quoted number rather than coercing it", async () => {
    // `PATCH /api/leads/:id {score:"50"}` was a 500.
    const result = validateBody({ n: "5" }, counts);
    assert.match((await body(result.error!)).error, /n must be a whole number, got "5" as text/);
  });

  it("keeps int and number apart", () => {
    assert.equal(validateBody({ f: 1.5 }, counts).ok, true);
    assert.equal(validateBody({ n: 1.5 }, counts).ok, false);
  });

  it("refuses NaN and Infinity, which JSON has no word for but a client can send", () => {
    assert.equal(validateBody({ f: null }, counts).ok, false);
    assert.equal(validateBody({ f: Number.NaN }, counts).ok, false);
    assert.equal(validateBody({ f: Number.POSITIVE_INFINITY }, counts).ok, false);
  });

  it("will not read a string as a boolean", async () => {
    // The `!!isDynamic` this replaced made "no" and [] mean true.
    const result = validateBody({ b: "yes" }, counts);
    assert.match((await body(result.error!)).error, /b must be true or false, got a string/);
  });

  it("honours min and max", async () => {
    // `Lead.score`'s comment says 0-100; `PATCH {score:9999}` was a 200 and put
    // that lead first on `GET /api/leads`, which orders by score.
    const bounded = { n: { kind: "int", min: 1, max: 3 } } satisfies Schema;
    assert.equal(validateBody({ n: 0 }, bounded).ok, false);
    assert.match((await body(validateBody({ n: 4 }, bounded).error!)).error, /at most 3/);
    assert.equal(validateBody({ score: 9999 }, LEAD_PATCH).ok, false);
    assert.equal(validateBody({ score: 100 }, LEAD_PATCH).ok, true);
  });
});

describe("the enum a SQLite column cannot enforce", () => {
  const row = { channel: { kind: "enum", values: ["EMAIL", "WHATSAPP"] } } satisfies Schema;

  it("refuses a value outside the set and lists the set", async () => {
    // `Job.status: "DONE"`, `Source.type: "MOON"`, `EnrichmentRule.trigger:
    // "WHEN"` and `Lead.seniority: "BOSS"` were all stored, and every comparison
    // the app makes with `===` then reads the row as if it were absent.
    const result = validateBody({ channel: "FAX" }, row);
    assert.match((await body(result.error!)).error, /channel must be one of EMAIL \| WHATSAPP, got "FAX"/);
  });

  it("does not fold case, because the code compares with ===", () => {
    assert.equal(validateBody({ channel: "email" }, row).ok, false);
    assert.equal(validateBody({ channel: "EMAIL" }, row).ok, true);
  });
});

describe("JSON columns", () => {
  const doc = { fields: { kind: "json" } } satisfies Schema;

  it("refuses the scalar a Json column takes without complaint", () => {
    // `Source.config: 42` and `LeadList.filterJson: 42` were 201s. Nothing here
    // can read a number as a filter.
    assert.equal(validateBody({ fields: 42 }, doc).ok, false);
    assert.equal(validateBody({ fields: "x" }, doc).ok, false);
    assert.equal(validateBody({ fields: { a: 1 } }, doc).ok, true);
    assert.equal(validateBody({ fields: [1, 2] }, doc).ok, true);
  });

  it("refuses null and says what to send instead", async () => {
    // Prisma writes a NULL into a Json column with its own DbNull sentinel, so a
    // caller's null has no honest translation at this boundary.
    const result = validateBody({ fields: null }, doc);
    assert.match((await body(result.error!)).error, /send \{\} to clear it/);
  });

  it("caps what one request can store", async () => {
    const result = validateBody(
      { fields: { blob: "x".repeat(2048) } },
      { fields: { kind: "json", max: 100 } } satisfies Schema,
    );
    assert.match((await body(result.error!)).error, /bytes of JSON; at most 100/);
  });
});

describe("an array of strings, which three columns and one id list all are", () => {
  const tags = { tags: { kind: "strings" } } satisfies Schema;

  it("refuses the scalar that a later reader spreads", async () => {
    // `mergeLeads` in `dedupe.ts` does `[...new Set([...master.tags, ...duplicate.tags])]`:
    // a string stored there is not a 201, it is a 500 in some later merge.
    assert.equal(validateBody({ tags: "abc" }, tags).ok, false);
    assert.match((await body(validateBody({ tags: "abc" }, tags).error!)).error, /tags must be an array of strings/);
    assert.match(
      (await body(validateBody({ tags: [1] }, tags).error!)).error,
      /tags\[0\] must be text, got a number/,
    );
  });

  it("treats absent as nothing sent, not as empty", async () => {
    // The difference is what a PATCH must not do: clearing tags because the
    // caller renamed the lead. The route that needs the empty array says so.
    assert.equal("tags" in (validateBody({ name: "x" }, ONE).data ?? {}), false);
    assert.deepEqual(validateBody({ tags: [] }, tags).data?.tags, []);
  });

  it("deduplicates and trims, so [id, id] is one membership", () => {
    assert.deepEqual(validateBody({ tags: [" b ", "a", "b"] }, tags).data?.tags, ["b", "a"]);
  });

  it("enforces a minimum the column's reader depends on", async () => {
    // `EnrichmentRule.providers` feeds the `?action=run` config and the worker's
    // `for (const provider of config.providers)`.
    const providers = { providers: { kind: "strings", required: true, min: 1 } } satisfies Schema;
    assert.match(
      (await body(validateBody({ providers: [] }, providers).error!)).error,
      /providers must hold at least one entry/,
    );
    assert.equal(validateBody({ providers: ["apollo"] }, providers).ok, true);
    assert.match((await body(validateBody({}, providers).error!)).error, /providers is required/);
  });

  it("checks each entry against a declared set, for an array of names", async () => {
    // `Export.fields` is rendered by the exporter as `lead[field]`, so a name
    // that is not a Lead column becomes an empty column in a downloaded file.
    const result = validateBody({ format: "CSV", fields: ["email", "nope"] }, EXPORT_CREATE);
    assert.equal(result.ok, false);
    assert.match((await body(result.error!)).error, /fields\[1\] must be one of .* got "nope"/);
    assert.equal(validateBody({ format: "CSV", fields: ["email", "score"] }, EXPORT_CREATE).ok, true);
  });

  it("caps the list", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `t${i}`);
    assert.match(
      (await body(validateBody({ tags: many }, tags).error!)).error,
      /tags holds 101 entries; at most 100/,
    );
  });

  it("is the same rule `asStrings` uses for an id list", async () => {
    // One array, one message, whether it arrives as `tags` or `listIds`.
    const direct = await body(stringList("abc", "listIds").error!);
    const wrapped = await body(validateBody({ tags: "abc" }, tags).error!);
    assert.equal(direct.error, "listIds must be an array of strings");
    assert.match(wrapped.error, /tags must be an array of strings/);
  });
});

describe("null", () => {
  it("clears a nullable column and is refused on one that is not", async () => {
    assert.equal(validateBody({ name: "x", nickname: null }, ONE).data?.nickname, null);
    const result = validateBody({ name: "x", nickname: null }, { name: { kind: "text" }, nickname: { kind: "text" } } satisfies Schema);
    assert.equal(result.ok, false);
  });

  it("is not the same as leaving a field out", async () => {
    const absent = validateBody({ name: "x" }, ONE);
    assert.equal(absent.ok && "nickname" in absent.data, false);
    const sent = validateBody({ name: "x", nickname: null }, ONE);
    assert.equal(sent.ok && "nickname" in sent.data, true);
  });
});

describe("PATCH", () => {
  it("refuses a body that asks to change nothing", async () => {
    // Measured: `lead.update({ data: {} })` resolves and returns the row
    // untouched, so `PATCH {}` and `PATCH {nope:1}` were both a 200 with nothing
    // behind them.
    assert.match((await body(validateBody({ foo: 1 }, LEAD_PATCH, { requireWrite: true }).error!)).error, new RegExp(NO_FIELD_TO_UPDATE));
    assert.equal(validateBody({}, LEAD_PATCH, { requireWrite: true }).ok, false);
    assert.equal(validateBody({ company: null }, LEAD_PATCH, { requireWrite: true }).ok, true);
    assert.equal(validateBody({ company: "x" }, LEAD_PATCH, { requireWrite: true }).ok, true);
  });

  it("reports a missing required field ahead of the empty-update rule", async () => {
    const result = validateBody({ foo: 1 }, { status: { kind: "enum", required: true, values: ["NEW"] } }, { requireWrite: true });
    assert.match((await body(result.error!)).error, /status is required/);
  });
});

describe("event names on a String column", () => {
  it("accepts the array the schema comment shows and the comma string the reader splits", () => {
    // `events: ["a.b", "c.d"]` measured as a 500: the column is a String and
    // Prisma will not put an array in it.
    assert.deepEqual(eventNames(["a.b", "c.d"]).values, ["a.b", "c.d"]);
    assert.deepEqual(eventNames("a.b, c.d").values, ["a.b", "c.d"]);
    assert.deepEqual(eventNames(["a.b", "a.b", ""]).values, ["a.b"]);
  });

  it("refuses the shapes that reach Prisma as an array or nothing at all", async () => {
    assert.match((await body(eventNames([42]).error!)).error, /every event must be text/);
    assert.match((await body(eventNames([]).error!)).error, /at least one event/);
    assert.match((await body(eventNames(undefined).error!)).error, /must be an array/);
    assert.match((await body(eventNames(["two words"]).error!)).error, /letters, digits/);
  });
});
