// The contract's names, in the places an integrator or a repair reads.
//
// `public/llms.txt` is a *static* file, unlike the hub's — so the two contract
// paths go stale in exactly the way generated files cannot. And the
// discovery-path alias at `/openapi.json` must call `/api/openapi`'s handler
// rather than re-export it: the route scanner reads handlers out of their own
// file, and a re-export names a function in another one. Both are one edit
// away from rotting again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../..", import.meta.url).pathname;
const LLM = readFileSync(`${ROOT}/public/llms.txt`, "utf8");
const VERSIONED = readFileSync(`${ROOT}/src/app/api/openapi/route.ts`, "utf8");
const DISCOVERY = readFileSync(`${ROOT}/src/app/openapi.json/route.ts`, "utf8");

test("llms.txt names the contract where an integrator looks for it", () => {
  for (const path of ["/api/openapi", "/openapi.json"]) {
    assert.ok(LLM.includes(path), `llms.txt should name the contract path ${path}`);
  }
});

test("/openapi.json calls the versioned handler instead of re-exporting it", () => {
  assert.match(VERSIONED, /export async function GET/, "the versioned route carries its own handler");
  assert.match(DISCOVERY, /GET as contract/, "the discovery route imports the handler");
  assert.match(DISCOVERY, /return contract\(\)/, "the discovery route calls it");
  assert.doesNotMatch(
    DISCOVERY,
    /export\s*\{[^}]*GET[^}]*\}\s*from/,
    "a re-export breaks the route scanner — the file that answers must carry the handler",
  );
});

test("the contract names the app's version", async () => {
  const { openapiSpec } = await import("../../src/lib/openapi");
  const { VERSION } = await import("../../src/lib/version");
  assert.equal(openapiSpec.info.version, VERSION);
});
