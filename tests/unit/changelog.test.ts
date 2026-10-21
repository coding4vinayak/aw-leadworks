// The changelog is the page a buyer — and an assistant — reads to see what is
// new.
//
// It drifted: the app gained CSV import, and the changelog still said the older
// release was the newest thing here. So the shipped features are listed below
// and the test fails if one of them stops being mentioned.
//
// **When you ship a public feature, add it here and write the changelog entry.**
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHANGELOG = readFileSync(new URL("../../src/app/changelog/page.tsx", import.meta.url), "utf8");

const SHIPPED = [
  { feature: "the CSV import", marks: ["CSV import"] },
  { feature: "the score arithmetic", marks: ["score"] },];

test("the changelog mentions every feature the app ships", () => {
  for (const { feature, marks } of SHIPPED) {
    for (const mark of marks) {
      assert.ok(CHANGELOG.includes(mark), `the changelog must mention ${feature} ("${mark}")`);
    }
  }
});

test("the entries read newest first", () => {
  // A v1.10 written below v1.9 is a lie about the order, and the order is
  // the whole point of the page.
  const versions = [...CHANGELOG.matchAll(/v(\d+)\.(\d+)\.(\d+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
  ]);
  assert.ok(versions.length >= 2, "the changelog should have entries");
  for (let i = 1; i < versions.length; i++) {
    const [a, b, c] = versions[i - 1];
    const [x, y, z] = versions[i];
    const newer = a > x || (a === x && (b > y || (b === y && c > z)));
    assert.ok(newer, `v${a}.${b}.${c} must come before v${x}.${y}.${z}`);
  }
});
