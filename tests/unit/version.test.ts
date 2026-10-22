// The version on the front page, and the changelog it has to match.
//
// The badge said "v1.0" on every landing page while the changelogs said v1.1
// to v1.4 — a small lie on the page a buyer reads first. The version now
// lives in one place, the badge renders it, and this test holds the two
// together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "../../src/lib/version";

const CHANGELOG = readFileSync(new URL("../../src/app/changelog/page.tsx", import.meta.url), "utf8");
const LANDING = readFileSync(new URL("../../src/app/page.tsx", import.meta.url), "utf8");

test("the version on the front page is the version in the changelog", () => {
  const versions = [...CHANGELOG.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(versions.length > 0, "the changelog should have entries");
  assert.equal(versions[0], VERSION, "the newest changelog entry is the version");
});

test("the landing page reads the version instead of claiming one", () => {
  assert.ok(LANDING.includes("{VERSION}"), "the badge must render the shared version");
  assert.ok(
    !/v\d+\.\d+(\.\d+)? · Now generally available/.test(LANDING),
    "a hard-coded version is how the badge drifts",
  );
});
