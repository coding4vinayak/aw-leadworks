/**
 * The deep-content file cannot drift.
 *
 * `public/llms-full.txt` is generated from the shipped index and the contract
 * (`buildLlmsFull` — see `src/lib/llms-full.ts`). It is shipped as a file so
 * every static-server and sweep sees a normal file, and a test compares it
 * against the live sources at unit-test time: after the index or the contract
 * changes, a stale full file fails the build naming the first line that moved.
 * The contract check (`scripts/check-contract.mts`) holds the spec; this test
 * holds the prose that quotes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLlmsFull } from "../../src/lib/llms-full";
import { openapiOperations } from "../../src/lib/openapi";
import { VERSION } from "../../src/lib/version";

const ROOT = new URL("../..", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");

const FULL = read("public/llms-full.txt");
const INDEX = read("public/llms.txt");

test("the committed deep-content file is the builder's own output over the live sources", () => {
  const origin = /^Canonical host: (\S+)/m.exec(INDEX)?.[1];
  assert.ok(origin, "the llms.txt carries a `Canonical host:` line — the file is built against it");
  assert.equal(
    FULL,
    buildLlmsFull({ index: INDEX, version: VERSION, origin: origin as string, operations: openapiOperations }),
    "public/llms-full.txt is stale — rebuild it: npx tsx scripts/build-llms-full.mts",
  );
});

test("the index is carried verbatim — one fetch holds both", () => {
  assert.ok(FULL.includes(INDEX.trimEnd()), "the llms.txt's whole body sits inside the full file");
});

test("every operation the contract answers is named, with its own summary and door", () => {
  for (const { path, method, operation } of openapiOperations) {
    const line = `- \`${method.toUpperCase()} ${path}\` — ${operation.summary}`;
    assert.ok(FULL.includes(line), `the full file must carry ${method.toUpperCase()} ${path} as the contract says it`);
  }
  assert.ok(FULL.includes(`${openapiOperations.length} operations`), "the operation count is stated, not hand-written");
});

test("the version it claims is the version the landing page wears", () => {
  assert.ok(FULL.includes(`build v${VERSION}`), `the file must say build v${VERSION}`);
});

test("the index points at its companion — and the file names itself", () => {
  assert.ok(INDEX.includes("llms-full.txt"), "the llms.txt must carry the `Full content:` pointer");
  assert.ok(FULL.includes(`This file: https://leadworks.abetworks.in/llms-full.txt`));
});

test("the deep file is never richer than the index about money", () => {
  const prices = (s: string) => [...s.matchAll(/\$\d[\d,]*/g)].map((m) => m[0]).sort();
  assert.ok(
    prices(FULL).every((p) => prices(INDEX).includes(p)),
    "a price appears in the full file that the index does not state — the prose inherited no invented price",
  );
});