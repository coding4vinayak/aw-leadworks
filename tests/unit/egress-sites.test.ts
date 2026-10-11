/**
 * Every address this server will connect to because something named it.
 *
 * Vendored next to the scanner it uses, for the scanner's own reason: six
 * hand-copied guards drift, and a guard whose job is to notice a missing check is the
 * worst possible file to have six copies of, because the failure mode is silence.
 *
 * The rule is per *call site*, not per app, and it reads the first argument, because
 * that argument is the whole question. `fetch("https://api.linkedin.com/v2/messages")`
 * is not an opening: the address is in the source, so no caller can move it.
 * `fetch(\`${baseUrl()}/chat/completions\`)` is not one either — `baseUrl()` reads
 * `process.env`, which is an operator's decision about infrastructure, not a
 * visitor's. `fetch(hook.url)` is exactly one, and so is `fetch(url)` when `url` was
 * rendered out of a workflow node's config out of a request body.
 *
 * So a site is legal in exactly four ways, and the fourth is the one that has to be
 * earned:
 *
 *   client    the file is a `"use client"` component — the browser makes that request,
 *             from the visitor's own machine, which was never this server's problem;
 *   literal   the host is fixed in the source (`"https://…"`, or a template that starts
 *             with one and can only vary the path);
 *   env       the address's root identifier is declared from `process.env` in the same
 *             file, or is a function whose body reads `process.env`;
 *   policy    an `assertAllowedTarget` / `classifyTarget` call sits immediately before
 *             the request, in the same block as far as lines can show a block.
 *
 * Anything else is a caller-named address going straight onto the wire, and it fails
 * with the file, the line and the argument text.
 *
 * Two limits are stated rather than hidden. The match is textual, so a check inside a
 * branch that the request does not actually pass through still counts as covering it —
 * the same weakness the auth guard has, in the same direction (it can be satisfied by
 * code that is unreachable, never by code that is missing). And `env` is one hop: an
 * address that reaches `fetch` through a variable assigned from another function that
 * reads the environment is not recognised, and fails as unexplained, which is the safe
 * way to be wrong about that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { blankComments, callArgs, functionBody } from "./route-handlers";

const SRC_ROOT = join(process.cwd(), "src");

/** How far above a request the policy call has to sit to count as being in its block. */
const BLOCK_LINES = 25;

interface Site {
  file: string;
  line: number;
  callee: string;
  arg: string;
  kind: "client" | "literal" | "env" | "policy" | "UNPROTECTED";
  why: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
  }
  return out.sort();
}

/**
 * Every call whose callee is named like a fetch — including the aliases.
 *
 * `const doFetch = fetchFn ?? fetch; … doFetch(url, …)` is how abetflow's executor
 * makes its request, and a pattern matching the bare word `fetch` walked straight past
 * it while measuring this: the site that needed checking most, because its address is
 * assembled out of run input, was the one the first version of this file could not see.
 */
const CALLEE = /([A-Za-z_$][\w$]*)?[Ff]etch([A-Za-z_$][\w$]*)?\s*\(/g;

function rootIdentifier(arg: string): string | null {
  const inner = arg.replace(/^["'`]|["'`]$/g, "");
  // A template's address is decided by the first thing interpolated into it:
  // `${baseUrl()}/chat/completions` is `baseUrl`'s address with a fixed suffix, while
  // `https://host/${path}` is a host nobody can move. Reading the first *word* instead
  // reads the `$` of the `${` as an identifier and the site becomes unexplainable.
  if (/^\$\{/.test(inner)) return /\$\{\s*([A-Za-z_$][\w$]*)/.exec(inner)?.[1] ?? null;
  if (/^https?:\/\//.test(inner)) return null;
  return /[A-Za-z_$][\w$]*/.exec(inner)?.[0] ?? null;
}

/** The declaration this identifier comes from: its line, or its function body. */
function declaredFrom(code: string, root: string): string {
  const line = new RegExp(`^.*\\b(?:const|let|var|function)\\s+${root}\\b.*$`, "m").exec(code)?.[0] ?? "";
  const body = functionBody(code, root) ?? "";
  return `${line}\n${body}`;
}

function classify(file: string): Site[] {
  const raw = readFileSync(join(process.cwd(), file), "utf8");
  const code = blankComments(raw);
  const isClient = /^\s*"use client";/.test(raw);
  const sites: Site[] = [];

  for (const match of code.matchAll(CALLEE)) {
    const start = match.index ?? 0;
    const open = start + match[0].length - 1;
    const arg = (callArgs(code, open)[0] ?? "").trim();
    const line = code.slice(0, start).split("\n").length;
    const callee = match[0].trim().replace(/\($/, "");
    const site = (kind: Site["kind"], why: string) => sites.push({ file, line, callee, arg, kind, why });

    if (isClient) site("client", "a browser component: the visitor's own machine makes this request");
    else if (/^["'`]https?:\/\//.test(arg)) site("literal", "the host is fixed in the source");
    else {
      const root = rootIdentifier(arg);
      if (root && /\bprocess\.env\b/.test(declaredFrom(code, root))) {
        site("env", `${root} comes from process.env, which is an operator's choice`);
      } else {
        const above = code.split("\n").slice(Math.max(0, line - 1 - BLOCK_LINES), line - 1).join("\n");
        if (/\b(?:assertAllowedTarget|classifyTarget)\s*\(/.test(above)) {
          site("policy", "the egress policy runs immediately before the request");
        } else {
          site("UNPROTECTED", root ? `${root} is not fixed in the source and not from the environment` : "no identifier in the address at all");
        }
      }
    }
  }
  return sites;
}

const SITES = sourceFiles(SRC_ROOT).flatMap((path) => classify(relative(process.cwd(), path).split(/[\\/]/).join("/")));

test("every outbound request either has an address the caller cannot move, or runs the policy first", () => {
  assert.ok(SITES.length > 0, "this app has no server-side request at all — the scan found nothing to judge");
  const offenders = SITES.filter((s) => s.kind === "UNPROTECTED");
  assert.deepEqual(
    offenders.map((s) => `${s.file}:${s.line}  ${s.callee}(${s.arg.slice(0, 60)})  —  ${s.why}`),
    [],
    "a fetch whose address a caller supplies, with no egress check above it",
  );
});

test("the exemptions are the ones this file claims, counted rather than trusted", () => {
  // The categories are the finding. If an app's `env` sites silently become `policy`
  // ones because somebody routed the LLM base URL through a request, or a client
  // component gains a server-side fetch, the shape of the table moves — and the table
  // is what the ledger's claim about this policy rests on.
  const byKind = (kind: Site["kind"]) => SITES.filter((s) => s.kind === kind).length;
  assert.equal(byKind("UNPROTECTED"), 0);
  assert.equal(
    byKind("client") + byKind("literal") + byKind("env") + byKind("policy"),
    SITES.length,
    "a site was counted in no category",
  );
  // A `policy` site proves the module is reachable from this app's own source, which
  // is what the auth drift check counts importers of; the guard says so out loud.
  if (byKind("policy") > 0) {
    assert.ok(
      readFileSync(join(process.cwd(), "src", "lib", "egress.ts"), "utf8").includes("export async function assertAllowedTarget"),
      "a site is covered by a policy call, but src/lib/egress.ts does not export it",
    );
  }
});
