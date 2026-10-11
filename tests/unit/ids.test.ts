// N4: ids and array columns a caller sends used to reach Prisma unvalidated,
// and every way of sending one wrongly was a 500. Measured on
// POST /api/leads before the fix — `listIds: ["nope"]` threw P2003 ("Foreign
// key constraint violated", no field named), `listIds: "abc"` threw
// `listIds.map is not a function`, `listIds: [42]` threw a Prisma validation
// error, `listIds: [id, id]` answered 409 about a lead that did not exist yet,
// and `listIds: {a: 1}` answered 201 with no membership written at all. These
// pin what each of those costs now.
//
// A field that *names rows* is this file's business; the same array arriving as
// a column (`tags`, `providers`) is the `strings` kind in `src/lib/validate.ts`,
// which is where the parse these tests exercise now lives — `asStrings` is a
// thin wrapper over it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asStrings, missingIds, unknownIdError, unknownIdsError } from "../../src/lib/ids";

const body = async (response: Response) => (await response.json()) as { error: string };

describe("a caller-supplied id list is checked before Prisma sees it", () => {
  it("treats absent, null and empty as nothing named", () => {
    // A body that never mentioned listIds must keep making the same lead it
    // made before: `undefined` and `null` are not errors, they are no lists.
    assert.deepEqual(asStrings(undefined, "listIds").values, []);
    assert.deepEqual(asStrings(null, "listIds").values, []);
    assert.deepEqual(asStrings([], "listIds").values, []);
  });

  it("refuses a bare string instead of calling .map on it", async () => {
    // `listIds: "abc"` has a length, so the old `?.length` guard accepted it
    // and `listIds.map` threw a TypeError on the next line.
    const result = asStrings("abc", "listIds");
    assert.equal(result.values, null);
    assert.equal(result.error?.status, 400);
    assert.match((await body(result.error!)).error, /^listIds must be an array/);
  });

  it("refuses an object, which used to answer 201 and write nothing", async () => {
    // The worst of the set: `{a: 1}` has no .length, so the membership block
    // was skipped entirely and the caller got a 201 for a lead outside every
    // list it named.
    const result = asStrings({ a: 1 }, "listIds");
    assert.equal(result.error?.status, 400);
  });

  it("names the field, not the value, in the type error", async () => {
    const result = asStrings([42], "listIds");
    assert.equal(result.error?.status, 400);
    assert.equal((await body(result.error!)).error, "every listIds entry must be a non-empty string");
  });

  it("rejects an empty id rather than letting Prisma call it not-found", async () => {
    const result = asStrings([""], "listIds");
    assert.equal(result.error?.status, 400);
    assert.equal((await body(result.error!)).error, "every listIds entry must be a non-empty string");
  });

  it("drops a repeated id without losing the order of the rest", () => {
    // LeadListMember is unique on (listId, leadId), so [id, id] collided with
    // itself inside one insert and came back as a 409 on a create.
    assert.deepEqual(asStrings(["b", "a", "b", "a", "c"], "listIds").values, ["b", "a", "c"]);
  });

  it("caps how many ids one request may name", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `list_${i}`);
    const result = asStrings(many, "listIds");
    assert.equal(result.error?.status, 400);
    assert.equal((await body(result.error!)).error, "listIds holds 250 entries; at most 100");
    // The cap is the caller's to raise knowingly, not ours to assume.
    assert.deepEqual(asStrings(many, "listIds", 300).values?.length, 250);
  });
});

describe("an id the workspace does not have is named, not just refused", () => {
  it("lists the unknown ids and keeps the response parseable", async () => {
    const response = unknownIdsError("listIds", ["a", "b"]);
    assert.equal(response.status, 422);
    const parsed = (await response.json()) as { error: string; unknownIds: string[] };
    assert.deepEqual(parsed.unknownIds, ["a", "b"]);
    assert.equal(parsed.error, "listIds holds 2 ids this workspace does not have: a, b");
  });

  it("truncates the message but not the machine-readable list", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const parsed = (await unknownIdsError("listIds", ids).json()) as { error: string; unknownIds: string[] };
    assert.equal(parsed.unknownIds.length, 7);
    assert.match(parsed.error, /a, b, c, d, e \(\+2 more\)$/);
  });

  it("says id, not ids, for exactly one", async () => {
    const parsed = (await unknownIdsError("listIds", ["solo"]).json()) as { error: string };
    assert.equal(parsed.error, "listIds holds 1 id this workspace does not have: solo");
  });

  it("reports the ids the database did not return, in the caller's order", () => {
    assert.deepEqual(missingIds(["x", "y", "z"], [{ id: "z" }, { id: "x" }]), ["y"]);
    assert.deepEqual(missingIds(["x"], [{ id: "x" }]), []);
  });

  it("answers the same way for the scalar foreign keys that name one row", async () => {
    // `Job.sourceId` and `Export.profileId`: measured, a value Prisma could not
    // resolve left as P2003 with no field named, because the route had only
    // checked that the caller sent *something*.
    const response = unknownIdError("sourceId", "nope");
    assert.equal(response.status, 422);
    const parsed = (await response.json()) as { error: string; unknownIds: string[] };
    assert.equal(parsed.error, "sourceId is not an id this workspace has: nope");
    assert.deepEqual(parsed.unknownIds, ["nope"]);
  });
});
