// #77 — one address, one person, at every door that compares an address.
//
// The defect this round measured is a contradiction between two doors. `@@unique([workspaceId,
// email])` compares bytes, but the product has folded case since `7ecf030` (#99) at the two doors
// that take an address from a caller — they refuse a case-changed collision with a 409 naming the
// row — and `csv-import.ts` has looked up with `mode: "insensitive"` since before that. The read
// door compared bytes, so over a row stored as `John@X.com`:
//
//   GET  /api/leads?email=john@x.com     200 total=0   — "nobody by that name"
//   POST /api/leads {email:"john@x.com"} 409           — "already exists … as ld_… with the case changed"
//
// One address, two answers, from the same workspace in the same breath. Guessing the stored
// spelling was not available either: the one-lead door stores what it was sent and the file door
// lower-cases, so the caller had no way to write the query that matches.
//
// The fix is the one this app already runs at the write doors, written once: `emailFold()` and
// `emailFoldIn()` in `lead-email.ts`, called by all four comparisons (GET's filter, POST's and
// PATCH's holder lookups, and the importer's page of addresses). This file pins the rule and the
// census that keeps a fifth door from spelling it differently.
//
// Nothing here needs a browser, a database or a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { blankComments, functionBody } from "./route-handlers";
import { emailFold, emailFoldIn } from "../../src/lib/lead-email";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const fromRoot = (relativePath: string) => at(`../../${relativePath}`);
const sourceTree = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  return [...walk("src")].sort();
};

const createDoor = fromRoot("src/app/api/leads/route.ts");
const editDoor = fromRoot("src/app/api/leads/[id]/route.ts");
const importer = fromRoot("src/lib/csv-import.ts");
const GET_body = blankComments(functionBody(createDoor, "GET_impl") ?? "");
const POST_body = blankComments(functionBody(createDoor, "POST_impl") ?? "");
const PATCH_body = blankComments(functionBody(editDoor, "PATCH_impl") ?? "");

test("the single-address comparison keeps the caller's bytes and does not fold in JavaScript", () => {
  // The database does the folding. Lower-casing here would be a second answer to "is this the same
  // person" — the one `dedupe.ts` uses — and it would still miss every case of a stored spelling.
  for (const asked of ["JOHN@X.COM", "bob@X.com", "john@x.com", "first.last+tag@sub.example.gov.uk"]) {
    assert.deepEqual(
      emailFold(asked),
      { equals: asked, mode: "insensitive" },
      `${asked} reaches the query exactly as the caller typed it`,
    );
  }
});

test("the fold escapes ILIKE's metacharacters, because the database reads the value as a pattern", () => {
  // The fold is `mode: "insensitive"`, which is `ILIKE` — and `ILIKE`'s `%` and `_` are wildcards.
  // Measured before the escape existed: `?email=%@x.com` answered `total=9` (every `@x.com` row),
  // `?email=a_c@x.com` named `abc@x.com`, and `?email=50%@x.com` returned the stored row beside
  // `50Z@x.com`. The escape is what makes the sentence "one address" true for an address that
  // contains a pattern character; without it the read door is a wildcard filter nobody documented.
  assert.deepEqual(emailFold("%@x.com"), { equals: "\\%@x.com", mode: "insensitive" });
  assert.deepEqual(emailFold("a_c@x.com"), { equals: "a\\_c@x.com", mode: "insensitive" });
  assert.deepEqual(emailFold("50%@x.com"), { equals: "50\\%@x.com", mode: "insensitive" });
  // Backslash is LIKE's own escape character, so it is escaped too — a caller-supplied `\` must
  // not be able to escape the `%` that follows it.
  assert.deepEqual(emailFold("a\\b@x.com"), { equals: "a\\\\b@x.com", mode: "insensitive" });
  // And an address with no pattern character is untouched: the escape adds nothing to guess at.
  assert.deepEqual(emailFold("first.last+tag@sub.example.gov.uk"), {
    equals: "first.last+tag@sub.example.gov.uk",
    mode: "insensitive",
  });
});

test("a page of addresses is the same comparison, as `in`, escaped the same way", () => {
  const page = ["A@x.com", "50%@x.com", "a_c@x.com"];
  assert.deepEqual(emailFoldIn(page), {
    in: ["A@x.com", "50\\%@x.com", "a\\_c@x.com"],
    mode: "insensitive",
  });
  assert.deepEqual(page, ["A@x.com", "50%@x.com", "a_c@x.com"], "the caller's array is not rewritten in place");
});

test("the read door folds through the shared rule", () => {
  assert.match(GET_body, /if \(email\.value\) where\.email = emailFold\(email\.value\)/);
  assert.doesNotMatch(GET_body, /mode: "insensitive"/, "the door names the rule instead of spelling it");
  assert.match(createDoor, /import \{[^}]*\bemailFold\b[^}]*\} from "@\/lib\/lead-email"/);
});

test("the two write doors and the importer fold through the same rule", () => {
  assert.match(POST_body, /email: emailFold\(askedEmail\)/, "POST's holder lookup");
  assert.match(PATCH_body, /email: emailFold\(askedEmail\)/, "PATCH's holder lookup");
  assert.match(importer, /email: emailFoldIn\(emails\)/, "the importer's page of addresses");
  assert.match(editDoor, /import \{[^}]*\bemailFold\b[^}]*\} from "@\/lib\/lead-email"/);
  assert.match(importer, /import \{ emailFoldIn \} from "\.\/lead-email"/);
});

test("the census: every address comparison in the app is one of these four calls", () => {
  // A fifth door that compares an address byte-wise is the hole this round closed, so the census
  // is the list of who asks the question and nothing else. Two known holdouts are named below
  // rather than silently excluded.
  const callers: string[] = [];
  for (const file of sourceTree()) {
    if (file === "src/lib/lead-email.ts") continue;
    const code = blankComments(fromRoot(file));
    for (const match of code.matchAll(/\bemailFold(In)?\(/g)) {
      callers.push(`${file} — ${match[0]}`);
    }
  }
  assert.deepEqual(callers, [
    "src/app/api/leads/[id]/route.ts — emailFold(",
    "src/app/api/leads/route.ts — emailFold(",
    "src/app/api/leads/route.ts — emailFold(",
    "src/lib/csv-import.ts — emailFoldIn(",
  ]);
  // What the list is a census of: the literal comparison is written in exactly one file.
  const spellers = sourceTree().filter((file) => /mode: "insensitive"/.test(blankComments(fromRoot(file))));
  assert.deepEqual(spellers, ["src/lib/lead-email.ts"]);
});

test("the holdout that is not a caller: the scrape's composite-key lookup is still byte-exact", () => {
  // Named rather than folded in. `scraper.ts` matches a provider's row with
  // `findUnique({ where: { workspaceId_email: … } })` — as case-blind as the index this round
  // stopped trusting — so a scrape of `JOHN@X.COM` beside `john@x.com` still creates a second row.
  // It is not an HTTP door, its address is a provider's field rather than a caller's typo, and this
  // round did not measure it; `lead-email-case.test.ts` records the same standstill.
  const scrape = blankComments(fromRoot("src/lib/scraper.ts"));
  assert.match(scrape, /where: \{ workspaceId_email: \{ workspaceId, email: lead\.email \} \}/);
  assert.doesNotMatch(scrape, /insensitive|emailFold/);
});

test("the contract says the match is folded, because the old sentence promised a byte-exact one", () => {
  const door = openapiOperations.find((entry) => entry.operation.id === "leads.list")!;
  const described = (door.operation.query ?? []).find(([name]) => name === "email")!;
  assert.ok(described[1].includes("folded, not exact"));
  assert.ok(described[1].includes("not wildcards"));
  assert.ok(!described[1].includes("byte-exact"), "the claim the round measured to be false is gone");
});

test("no read door lower-cases or otherwise rewrites an address before it asks", () => {
  for (const [name, body] of [["GET", GET_body], ["POST", POST_body], ["PATCH", PATCH_body]] as const) {
    assert.doesNotMatch(body, /askedEmail\.toLowerCase|email\.value\.toLowerCase|normalizeEmail/, `${name} keeps the bytes`);
  }
  assert.match(blankComments(importer), /normalizeEmail|toLowerCase\(\)/, "the file door alone rewrites what it stores");
});

test("the README quotes the same measurement this file pins", () => {
  // The section is the record a reader sees; these lines are why it can be trusted. Each was
  // copied from a log this round wrote, and the escape's first-cut numbers are in it on purpose.
  const readme = fromRoot("README.md");
  assert.match(readme, /## One address, one answer: the read door folds the case the write doors fold/);
  assert.match(readme, /\?email=%@x\.com\s+200 total=9/, "the first cut's wildcard leg, kept in the table");
  assert.match(readme, /every\s+spelling now finds the row/, "the fix's own reading");
  assert.match(readme, /`src\/lib\/scraper\.ts` still looks a scraped address up byte-exactly/, "the holdout, named");
  assert.match(readme, /1347\/1347/, "and the suite count this tree measures");
});

test("the four comparisons are scoped to the caller's workspace, fold or no fold", () => {
  // The fold widens which rows match; it must not widen which workspace they come from.
  assert.match(GET_body, /const where: any = \{ workspaceId \}/);
  assert.match(POST_body, /where: \{ workspaceId, email: emailFold\(askedEmail\) \}/);
  assert.match(PATCH_body, /workspaceId: before\.workspaceId/);
  const importWhere = blankComments(importer).match(/where: \{ workspaceId, email: emailFoldIn\(emails\) \}/);
  assert.ok(importWhere, "the importer's page stays inside the workspace too");
});
