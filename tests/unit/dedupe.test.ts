// The dedupe rules, pinned where their rot was invisible.
//
// The failure this file exists for is not a crash: `mergeRecords` used to
// compute the merged record and then hit empty `if` branches with comments,
// while the job counted every duplicate as resolved and reported COMPLETED.
// Every typecheck passed. The pure rules (`planMerge`, `readDedupeConfig`,
// `normalizePhone`) are tested directly, and the writes that resolve a group
// are pinned by reading the source — going back to a comment-shaped branch
// fails a test instead of a customer's trust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planMerge, readDedupeConfig, normalizePhone } from "../../src/lib/dedupe";

const src = readFileSync(new URL("../../src/lib/dedupe.ts", import.meta.url), "utf8");

test("planMerge fills only blanks on the master", () => {
  const updates = planMerge(
    { email: "keep@example.com", firstName: "Ada" },
    { email: "other@example.com", firstName: "Grace", phone: "+15550100199", company: "Acme" },
  );
  assert.deepEqual(updates, { phone: "+15550100199", company: "Acme" });
});

test("planMerge unions arrays and merges object fields with the master winning", () => {
  const updates = planMerge(
    { tags: ["hot"], technologies: ["Next.js"], customFields: { tier: "gold", region: "EU" } },
    { tags: ["hot", "emea"], technologies: ["Prisma"], customFields: { tier: "silver", source: "import" } },
  );
  assert.deepEqual(updates.tags, ["hot", "emea"]);
  assert.deepEqual(updates.technologies, ["Next.js", "Prisma"]);
  assert.deepEqual(updates.customFields, { tier: "gold", source: "import", region: "EU" });
});

test("planMerge returns nothing to write when the duplicate adds nothing", () => {
  assert.deepEqual(planMerge({ email: "a@b.co", tags: [] }, { email: "c@d.co", tags: [] }), {});
});

test("readDedupeConfig refuses a strategy or action nothing implements", () => {
  assert.deepEqual(readDedupeConfig({ strategy: "email" }), { strategy: "email" });
  assert.deepEqual(readDedupeConfig({ strategy: "phone", action: "flag", keepOldest: true }), {
    strategy: "phone",
    action: "flag",
    keepOldest: true,
  });
  assert.throws(() => readDedupeConfig({ strategy: "ssn" }), /unknown strategy "ssn" — use one of email, phone, linkedin, company_name, fuzzy/);
  assert.throws(() => readDedupeConfig({ strategy: "email", action: "archive" }), /unknown action "archive" — use one of merge, delete, flag/);
  assert.throws(() => readDedupeConfig(null), /config must be an object/);
  assert.throws(() => readDedupeConfig({ strategy: "email", threshold: "high" }), /threshold must be a number/);
});

test("normalizePhone sees through the spellings a CRM actually stores", () => {
  assert.equal(normalizePhone("+1 (555) 010-0199"), normalizePhone("5550100199"));
  assert.equal(normalizePhone("1-555-010-0199"), normalizePhone("5550100199"));
  assert.notEqual(normalizePhone("+1 555 010 0199"), normalizePhone("+1 555 010 0198"));
  assert.equal(normalizePhone("+44 20 7946 0958"), "442079460958", "non-US numbers keep their country code");
  assert.equal(
    normalizePhone("+44 20 7946 0958"),
    normalizePhone("44 20 7946 0958"),
    "the sign is spelling, not identity — both spellings of the same number match",
  );
});

test("the three actions are real write paths, not comments", () => {
  assert.match(src, /planMerge\(master, duplicate\)/, "merge plans the update");
  assert.match(src, /await prisma\.lead\.update\([\s\S]*?where:\s*\{ id: master\.id \}[\s\S]*?scoredWriteData\(rowAfterWrite\(master, updates\)\)/, "merge writes the enriched master, and the score the merged row earns");
  assert.match(src, /await prisma\.lead\.delete\(\{ where: \{ id: duplicate\.id \} \}\)/, "merge and delete remove the duplicate");
  assert.match(src, /tags: \[\.\.\.new Set\(\[\.\.\.tags, "duplicate"\]\)\]/, "flag tags the duplicate");
  assert.match(src, /duplicateOf: master\.id, jobId/, "flag leaves the pairing on the timeline");
  assert.doesNotMatch(src, /\/\/ Delete duplicate\b/, "the comment-shaped branch stays gone");
});
