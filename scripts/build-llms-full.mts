/**
 * Build `public/llms-full.txt` from the sources that cannot lie.
 *
 *   npx tsx scripts/build-llms-full.mts           # write when it changed
 *   npx tsx scripts/build-llms-full.mts --check   # CI: exit 1 naming the drift
 *
 * The sources are the shipped index (`public/llms.txt`) and the contract
 * (`src/lib/openapi.ts`) — the same data the contract routes serve. If either
 * changed, this file is stale, and a stale deep-content file is a file that
 * quotes an API that moved.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildLlmsFull } from "../src/lib/llms-full";
import { openapiOperations } from "../src/lib/openapi";
import { VERSION } from "../src/lib/version";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const INDEX_PATH = join(ROOT, "public", "llms.txt");
const OUT_PATH = join(ROOT, "public", "llms-full.txt");

const origin = /^Canonical host: (\S+)/m.exec(readFileSync(INDEX_PATH, "utf8"))?.[1];
if (!origin) {
  console.error("error: public/llms.txt carries no `Canonical host:` line — the full file is built against it");
  process.exit(1);
}

const content = buildLlmsFull({
  index: readFileSync(INDEX_PATH, "utf8"),
  version: VERSION,
  origin,
  operations: openapiOperations,
});

const existing = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : null;

if (existing === content) {
  console.log("unchanged: public/llms-full.txt");
} else if (process.argv.includes("--check")) {
  if (existing === null) {
    console.error("drift: public/llms-full.txt does not exist — build it: npx tsx scripts/build-llms-full.mts");
  } else {
    const a = existing.split("\n");
    const b = content.split("\n");
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
    console.error(
      `drift: public/llms-full.txt is stale against llms.txt or the contract — first difference at line ${i + 1}:` +
        `\n  file: ${a[i] ?? "(end)"}\n  built: ${b[i] ?? "(end)"}`,
    );
  }
  process.exit(1);
} else {
  writeFileSync(OUT_PATH, content);
  console.log("wrote: public/llms-full.txt");
}