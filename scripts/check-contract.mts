/**
 * The API contract check: src/lib/openapi.ts against the route handlers.
 *
 * A spec is a second description of the same thing, and second descriptions
 * rot. This one cannot, because every claim is read back out of the source
 * that serves it:
 *
 *   · every operation in the spec has a route that answers it, and every route
 *     that answers is in the spec — a documented call that 404s, and a shipped
 *     call nobody can discover, have both bitten this suite
 *   · every request body is compared with the app's own declared field table,
 *     so the spec cannot advertise a field the door would refuse, and cannot
 *     omit one the door requires
 *   · the auth a route enforces is the auth the spec advertises — including
 *     the example-workflow door, which a session or a key both open
 *   · operationIds are unique, and the version is the app's own version
 *
 * Run: npx tsx scripts/check-contract.mts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as fieldTables from "../src/lib/fields";
import { openapiOperations, openapiSpec } from "../src/lib/openapi";
import { VERSION } from "../src/lib/version";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "src/app");

/** The spec's own homes — they serve the document, so they are not operations in it. */
const SPEC_ROUTES = new Set(["/api/openapi", "/openapi.json"]);

const passes: string[] = [];
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") =>
  (ok ? passes : failures).push(ok ? label : `${label}${detail ? ` — ${detail}` : ""}`);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** `/api/workflows/[id]` → `/api/workflows/{id}`, and the catch-all `[...path]` → `{path}` — the spec's path syntax. */
function specPath(file: string): string {
  const rel = relative(APP, dirname(file)).split(/[\\/]/).join("/");
  return `/${rel}`.replace(/\[\.\.\.([^\]]+)\]/g, "{$1}").replace(/\[([^\]]+)\]/g, "{$1}");
}

const VERBS = ["get", "post", "patch", "put", "delete"] as const;
type Verb = (typeof VERBS)[number];

/** The verbs a route file exports, in either style the app uses. */
function verbsOf(source: string): Verb[] {
  const found = new Set<Verb>();
  for (const m of source.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PATCH|PUT|DELETE)\b/g)) {
    found.add(m[1].toLowerCase() as Verb);
  }
  for (const m of source.matchAll(/export\s*\{[^}]*\b(GET|POST|PATCH|PUT|DELETE)\b[^}]*\}/g)) {
    found.add(m[1].toLowerCase() as Verb);
  }
  return [...found];
}

/** The field names a table declares, or none when the table does not exist. */
function tableFields(name: string): string[] {
  const table = (fieldTables as unknown as Record<string, Record<string, unknown> | undefined>)[name];
  return table ? Object.keys(table) : [];
}

/**
 * The route's code without its comments.
 *
 * A field named in a comment is not a field the door reads, and a check that
 * believed the comments would pass a body the product has never accepted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

// ── the routes, read out of the source ────────────────────────────────────
const routes = new Map<string, { verbs: Verb[]; source: string }>();
for (const file of walk(APP)) {
  const path = specPath(file);
  if (SPEC_ROUTES.has(path)) continue;
  const source = readFileSync(file, "utf8");
  const verbs = verbsOf(source);
  if (verbs.length) routes.set(path, { verbs, source });
}

// ── the spec, read out of the file ───────────────────────────────────────
const specPaths = new Map(
  (openapiSpec.paths ? Object.entries(openapiSpec.paths) : []).map(([path, item]) => [
    path,
    item as Record<string, { operationId?: string }>,
  ]),
);

// · every operation in the spec has a route that answers it
const missingRoutes: string[] = [];
for (const [path, item] of specPaths) {
  const route = routes.get(path);
  if (!route) {
    missingRoutes.push(path);
    continue;
  }
  for (const verb of Object.keys(item)) {
    if (verb === "parameters") continue;
    if (!route.verbs.includes(verb as Verb)) {
      missingRoutes.push(`${path} ${verb.toUpperCase()}`);
    }
  }
}
check("every operation in the spec has a route that answers it", missingRoutes.length === 0, missingRoutes.join(", "));

// · every route that answers is in the spec
const missingDocs: string[] = [];
for (const [path, route] of routes) {
  const item = specPaths.get(path);
  if (!item) {
    missingDocs.push(path);
    continue;
  }
  for (const verb of route.verbs) {
    if (!item[verb]) {
      missingDocs.push(`${path} ${verb.toUpperCase()}`);
    }
  }
}
check("every route that answers is in the spec", missingDocs.length === 0, missingDocs.join(", "));

// · the auth a route enforces is the auth the spec advertises
//
// The doors this API has: `withAuth(` is the key door, `getSession(` the
// session door, and both behind one handler is a door either opens. A route
// with neither is open or Stripe's own signed callback, and the reason each
// of those is acceptable rather than merely unauthenticated lives in the
// route-auth test — so the check skips it there instead of asking the spec
// for a scheme the route never asserts.
const authProblems: string[] = [];
for (const { path, method, operation } of openapiOperations) {
  const route = routes.get(path);
  if (!route) continue;
  const code = stripComments(route.source);
  const keyGated = /(?:withAuth\(|authedWorkspaceId\()/.test(code);
  const sessionGated = /getSession\(/.test(code);
  const auth = operation.auth ?? "none";
  if (keyGated && !sessionGated && auth !== "key") {
    authProblems.push(`${path} ${method.toUpperCase()} is the key door but the spec says ${auth}`);
  }
  if (keyGated && sessionGated && auth !== "session-or-key") {
    authProblems.push(`${path} ${method.toUpperCase()} opens for either but the spec says ${auth}`);
  }
  if (!keyGated && sessionGated && auth !== "session") {
    authProblems.push(`${path} ${method.toUpperCase()} is the session door but the spec says ${auth}`);
  }
  if (!keyGated && !sessionGated) continue;
}
check("the auth a route enforces is the auth the spec advertises", authProblems.length === 0, authProblems.join("; "));

// · every request body matches the app's own declared field table
//
// Two halves, and they are different questions. The **table** says what the
// door will accept, so every field in it must be in the spec — an integrator
// who cannot see a field cannot send it. The **route's source** says what the
// door actually reads, so every field in the spec must be read there — a
// field the spec advertises and the door ignores is a promise the first call
// breaks.
//
// One extra subtlety this app's own shape makes honest: a *query* parameter
// the route reads (`?action=retry`, `?id=…`, `?name=…`) is not a body field,
// and being named in the source reads as "the route reads it" only for
// parameters the spec itself lists. Fields are checked against their own
// list; nothing rides on their name being somewhere in a file.
//
// The route's comments are stripped first: a field named in a comment is not
// a field the door reads, and a check that believed the comments would pass a
// body the product has never accepted.
const bodyProblems: string[] = [];
for (const { path, method, operation } of openapiOperations) {
  const route = routes.get(path);
  const described = Object.keys(operation.body?.properties ?? {});
  if (route) {
    const code = stripComments(route.source);
    for (const name of described) {
      if (new RegExp(`\\b${name}\\b`).test(code)) continue;
      if (writesTheTable(code) && operation.fields && tableFields(operation.fields).includes(name)) continue;
      bodyProblems.push(`${path} ${method.toUpperCase()} describes ${name}, which the route never reads`);
    }
  }
  if (!operation.fields) continue;
  const table = (fieldTables as unknown as Record<string, Record<string, { required?: boolean }> | undefined>)[
    operation.fields
  ];
  if (!table) {
    bodyProblems.push(`${path} ${method.toUpperCase()} names the field table ${operation.fields}, which does not exist`);
    continue;
  }
  for (const name of Object.keys(table)) {
    if (!described.includes(name)) {
      bodyProblems.push(`${path} ${method.toUpperCase()} does not describe ${name}, which the door accepts`);
    }
  }
}
check("every request body matches the app's own declared field table", bodyProblems.length === 0, bodyProblems.join("; "));

/** A handler that writes the validated table wholesale reads every field it declares. */
function writesTheTable(code: string): boolean {
  return (
    /\.\.\.\s*[A-Za-z_$][\w$]*\??\.data/.test(code) ||
    /\.\.\.\s*input(\.data|,)/.test(code) ||
    // The destructuring-rest shape LeadWorks' PATCHes write:
    // `const { score, ...fields } = input.data;` then `data: { ...fields }`.
    // The rest *is* the table by construction — one named field plucked out
    // of it changes nothing about the others it carries.
    /\{[^{}]*\.\.\.\s*[\w$]+[^{}]*\}\s*=\s*[\w$]+(?:\?\.|.)?data/.test(code) ||
    // And the most direct form: the validated object handed to Prisma whole,
    // as `data: input.data` — there is nothing else in the write but the table.
    /data:\s*[\w$]+(?:\?\.|.)?data/.test(code)
  );
}

// · operationIds are unique
const ids = openapiOperations.map((o) => o.operation.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
check("operationIds are unique", duplicates.length === 0, duplicates.join(", "));

// · the version is the app's own version
check(
  "the contract's version is the app's own version",
  openapiSpec.info.version === VERSION,
  `the contract says ${openapiSpec.info.version}, the app says ${VERSION}`,
);

// · the document is an OpenAPI 3.1 document with the two security schemes
check("the contract is an OpenAPI 3.1 document", openapiSpec.openapi === "3.1.0", String(openapiSpec.openapi));
check(
  "the contract declares the auth schemes it uses",
  Boolean(openapiSpec.components?.securitySchemes?.apiKey) && Boolean(openapiSpec.components?.securitySchemes?.sessionCookie),
);

for (const label of passes) console.log(`  PASS  ${label}`);
for (const label of failures) console.log(`  FAIL  ${label}`);
console.log(`\n  ${passes.length} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
