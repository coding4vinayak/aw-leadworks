// The Blueprint is the checklist: every env var the code reads must be a key
// in render.yaml, so importing the manifest asks for exactly what this app
// needs — and a new env read in src/ can never silently miss the deploy.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Vars the runtime/platform provides — the manifest must never ask for these. */
const RUNTIME_PROVIDED = new Set(["NODE_ENV"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the Render manifest declares every env the code reads", () => {
  it("render.yaml covers src/ — nothing is read that an import would not ask for", () => {
    const declared = new Set(
      (readFileSync(path.join(ROOT, "render.yaml"), "utf8").match(/key:\s*[A-Z0-9_]+/g) ?? []).map((k) =>
        k.replace(/key:\s*/, ""),
      ),
    );
    const read = new Set<string>();
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.match(/process\.env\.[A-Z][A-Z0-9_]*/g) ?? []) {
        read.add(m.replace("process.env.", ""));
      }
      for (const m of text.match(/process\.env\["[A-Z][A-Z0-9_]*"\]/g) ?? []) {
        read.add(m.replace(/process\.env\["|"\]/g, ""));
      }
    }
    const missing = [...read].filter((v) => !declared.has(v) && !RUNTIME_PROVIDED.has(v)).sort();
    assert.deepEqual(missing, [], `render.yaml is missing: ${missing.join(", ")}`);
  });

  it("healthCheckPath points at the route that pings the database — not a page", () => {
    const manifest = readFileSync(path.join(ROOT, "render.yaml"), "utf8");
    const health = manifest.match(/healthCheckPath:\s*(\S+)/)?.[1];
    assert.ok(health, "render.yaml declares a healthCheckPath");
    assert.equal(health, "/api/health", "the health check is the DB-pinging route, not a page");
    assert.ok(
      existsSync(path.join(ROOT, "src/app", health.slice(1), "route.ts")),
      `${health} is backed by a route file`,
    );
  });
});
