// The route-file scanner, vendored — `shared/sync-guards.sh` is the only thing
// allowed to write the six copies, and `shared/check-guards-drift.sh` fails if one
// of them differs. Edit this file, then run the sync.
//
// Two structural rules read the same source: `route-auth.test.ts` (every handler
// authenticates, and every write sits under a check that dominates it) and
// `route-validation.test.ts` (every handler that reads a body validates it). A
// scanner copied twice drifts twice, and the whole point of the exercise is that a
// handler the scanner cannot see is a failure rather than a silence.
//
// The module answers two questions, and they are not the same shape. The first is
// about a handler *body*: where do calls sit in the control flow. The second is
// about a whole *file*: what arguments does this call pass (`schemaArgs`,
// `countCodeMentions`), which needs offsets preserved, so comments are blanked
// rather than deleted. §8.44 is why the second one moved here too: five of the six
// apps had a regex for it and one had a reader, and the two disagreed in silence.
//
// Why vendoring is safe *here* was measured before it moved: with comments and
// blank lines stripped the six copies were 201, 201, 201, 204, 204 and 201 lines,
// and the only difference in behaviour was that abetflow's and abetanalytics's copy
// export `functionBody` — which their own `route-validation.test.ts` calls, and the
// other four do not have. Every other difference was prose: four wordings of the
// same paragraph, and abetapi's note explaining that its copy needs no
// `functionBody` because abetapi has no wrapped exports at all. So this file is the
// superset, and what was lost in the merge is written down here instead of being
// re-typed six times.
//
// It has been wrong three different ways in this family, which is why the callers
// assert the scan itself (a measured handler count) instead of trusting a passing
// test: a regex requiring `id:` that never matched the shorthand `where: { id }`, a
// splitter that took the `{ params }` destructuring as the whole body, and a pattern
// on `export async function GET` that matched nothing in a codebase written as
// `GET_impl`.
//
// What the two export shapes are, measured across the six apps so the branch below
// can be judged: wrapped (`export const POST = withAuth(POST_impl)`) 40, 42, 16, 19,
// 20 against direct 8, 4, 4, 3, 1 in leadgenius, leadworks, abetagent, abetflow and
// abetanalytics; abetapi is the exception at 24 direct and 0 wrapped. The scanner
// resolves both, and refuses to guess about a third.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(process.cwd(), "src", "app");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export interface Handler {
  file: string;
  method: string;
  body: string;
}

function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) found.push(...routeFiles(p));
    else if (entry === "route.ts") found.push(p);
  }
  return found;
}

/** Skip the parameter list to depth 0, then take the brace block to depth 0. */
function bodyAfterParams(src: string, from: number): string {
  let i = src.indexOf("(", from);
  if (i < 0) return "";
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  let j = src.indexOf("{", i);
  if (j < 0) return "";
  depth = 0;
  const start = j;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}

function implBody(src: string, name: string): string | null {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  return bodyAfterParams(src, m.index);
}

/** Every function this block hands straight back to, in return position. */
function tailCalls(body: string): string[] {
  return [...body.matchAll(/\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
}

/**
 * The block, plus every same-file function it delegates to by returning its call.
 *
 * `export async function POST(request, ctx) { return trigger(request, ctx) }` is a
 * handler that neither authenticates nor writes as far as a brace-slice of its own
 * body is concerned — the code that does both is one line away in the same file, and
 * for as long as the scanner stopped at the outer block the auth guard passed that
 * route for never seeing a write. Resolution is transitive, and each function name
 * is followed at most once (the export's own names seed that set), so two helpers
 * that return each other's calls add each block once rather than spinning.
 *
 * A tail call to something that is not a function in this file — `return
 * NextResponse.json(…)`, or a helper imported from `@/lib/…` — resolves to nothing
 * and is left alone. The cross-file case is still a blind spot and the guard says
 * so in its own file rather than pretending otherwise here.
 *
 * `seenNames` is the set of blocks already in `body` — the exported function's own
 * name, and for a wrapped export the names whose blocks were merged in. Without it
 * a handler that returns a helper which returns the handler is appended twice.
 */
export function resolveDelegation(src: string, body: string, seenNames: string[]): string {
  const seen = new Set(seenNames);
  let out = body;
  let pending = tailCalls(body);
  while (pending.length > 0) {
    const next: string[] = [];
    for (const name of pending) {
      if (seen.has(name)) continue;
      seen.add(name);
      const inner = implBody(src, name);
      if (inner === null) continue;
      out += "\n" + inner;
      next.push(...tailCalls(inner));
    }
    pending = next;
  }
  return out;
}

/**
 * One named function's brace block, for a caller that has to read one delegation
 * by hand. `collectHandlers` now does this itself for every handler it returns, so
 * the only reason to call this directly is a test that wants to state the shape it
 * is checking rather than inherit the scan.
 */
export function functionBody(src: string, name: string): string | null {
  return implBody(src, name);
}

/**
 * Every exported handler, as `{ file, method, body }`, with delegations resolved.
 * A file whose export shape this cannot resolve throws rather than being skipped —
 * that is the failure mode that hid two anonymous routes.
 */
export function collectHandlers(): Handler[] {
  const handlers: Handler[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const src = readFileSync(file, "utf8");
    const rel = file.replace(process.cwd() + "/", "");
    for (const method of METHODS) {
      // Form 1: export async function GET(...) {}
      const direct = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`).exec(src);
      if (direct) {
        const own = bodyAfterParams(src, direct.index);
        handlers.push({ file: rel, method, body: resolveDelegation(src, own, [method]) });
        continue;
      }
      // Form 2: export const GET = withAuth(...) / = withAuth(withAiAuth(GET_impl))
      const alias = new RegExp(`export\\s+const\\s+${method}\\s*=([^;\n]*)`).exec(src);
      if (!alias) continue;
      const rhs = alias[1];
      if (/^\s*(async\s*)?\(/.test(rhs) || rhs.includes("=>")) {
        throw new Error(`${rel} ${method}: arrow-function export is not resolved by this scanner`);
      }
      const names = [...rhs.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
      let body = "";
      let resolved = false;
      for (const name of names) {
        const b = implBody(src, name);
        if (b !== null) { body += b; resolved = true; }
      }
      if (!resolved) throw new Error(`${rel} ${method}: export "${rhs.trim()}" names no function in this file`);
      handlers.push({ file: rel, method, body: resolveDelegation(src, rhs + "\n" + body, [...names, method]) });
    }
  }
  return handlers;
}

export { METHODS };

/**
 * Where a call sits in the handler's control flow.
 *
 * `chain` is the id of every brace block enclosing the call, outermost first —
 * the handler's own block is the first element. Two calls share a block when
 * their chains are equal, and one is inside the other's block when its chain has
 * the other's as a prefix. That is what makes it possible to ask the question
 * `route-auth.test.ts` could not: not "is there a key check in this body" but
 * "does a check dominate this write".
 *
 * The bug this exists for is abetagent's `PATCH /api/agents/[id]` at commit
 * c6a7db9: `assertOwns` inside `if (tools !== undefined) { if (unknown.length >
 * 0) {`, `prisma.agent.update` after both, at the handler's own level. Every
 * presence-based audit passed it — the check was in the file, in the body, in the
 * scanner's window — and a request with no Authorization header at all renamed
 * another workspace's agent (§8.18).
 *
 * It is a tokenizer over the handler's text, not an AST. String, template and
 * regex literals and comments are skipped, so a brace inside one cannot move the
 * chain; `case` labels and `else` share their parent's chain, which is the safe
 * direction (a check placed in a `case` above a write does not dominate it, and
 * this function will say so). A write in a function declared elsewhere in the
 * file is not in this body at all, which is what the `DELEGATES` list in
 * `route-auth.test.ts` is for.
 */
export interface CallSite {
  /** The matched name, e.g. `assertOwns` or `prisma.agent.update`. */
  name: string;
  /** Brace-block ids enclosing the call, outermost first. */
  chain: number[];
  /** Character offset in the body, so two sites can be ordered. */
  index: number;
  /** 1-based line within the body, for the message a person reads. */
  line: number;
}

export const AUTH_NAME =
  /\b(?:requireApiKey|authedWorkspaceId|assertOwns|getSession|requireSession|requireKey|verifyInboundWebhook|verifySignature|verifyWebhook|resolveAiActor|withAiAuth)\b/;
const WRITE_NAME = /\b(?:prisma|tx)\s*\.\s*[A-Za-z0-9_]+\s*\.\s*(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\b/;

/**
 * Reading rows. `prisma.$queryRaw` is here because a raw SELECT reads, and a route
 * that spells one out is not less accountable for what it returns than a
 * `findMany`. `$transaction` is deliberately not: what it commits is decided by the
 * calls inside its callback, which this matcher will find where they are written.
 *
 * Exported with `readSites`/`unguardedReads` for §8.42, which counted the read side
 * and shipped a rule that consults `authSites` instead — see the note on
 * `unguardedReads` for why the mirror of the write rule was the wrong question.
 */
const READ_NAME =
  /\b(?:prisma|tx)\s*\.\s*(?:\$queryRaw\b|[A-Za-z0-9_]+\s*\.\s*(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy)\b)/;

/**
 * The body with every string, template literal, regex literal and comment blanked
 * out, offsets preserved. Matching and brace-counting both happen on this, so a
 * `assertOwns` inside a sentence in a comment is not a check and a `{` inside a
 * string is not a block.
 */
function maskLiterals(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let lastSignificant = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(j, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      blank(j, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const j = i;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") { i += 2; continue; }
        if (c === "`" && src[i] === "$" && src[i + 1] === "{") {
          // An interpolation is code, but a call interpolated into a message is not
          // a call this guard can rely on, so it goes blank with the string.
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      blank(j, i);
      lastSignificant = c;
      continue;
    }
    if (c === "/" && /[=(,:[!&|?{};+*%^<>-]/.test(lastSignificant || "(")) {
      const j = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "\n") break;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      blank(j, i);
      lastSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out.join("");
}

/** Every block in the masked source as `[openIndex, closeIndex]`, outermost first. */
function blocks(masked: string): [number, number][] {
  const ranges: [number, number][] = [];
  const open: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") open.push(i);
    else if (masked[i] === "}") {
      const j = open.pop();
      if (j !== undefined) ranges.push([j, i]);
    }
  }
  return ranges;
}

function lineAt(masked: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (masked[i] === "\n") line++;
  return line;
}

/**
 * Every match of `pattern`, with the enclosing blocks and the line it sits on.
 */
function callSites(masked: string, ranges: [number, number][], pattern: RegExp): CallSite[] {
  const out: CallSite[] = [];
  for (const m of masked.matchAll(new RegExp(pattern.source, "g"))) {
    const index = m.index ?? 0;
    const chain = ranges
      .filter(([open, close]) => open < index && index < close)
      .sort((a, b) => a[0] - b[0])
      .map(([open]) => open);
    out.push({ name: m[0].replace(/\s+/g, ""), chain, index, line: lineAt(masked, index) });
  }
  return out;
}


const isPrefix = (short: number[], long: number[]): boolean =>
  short.length <= long.length && short.every((id, k) => long[k] === id);

interface Flow {
  auths: CallSite[];
  writes: CallSite[];
  reads: CallSite[];
}

/** All three call lists for one body, from one pass over the tokenizer. */
function flowOf(body: string): Flow {
  const masked = maskLiterals(body);
  const ranges = blocks(masked);
  return {
    auths: callSites(masked, ranges, AUTH_NAME),
    writes: callSites(masked, ranges, WRITE_NAME),
    reads: callSites(masked, ranges, READ_NAME),
  };
}

/** Every database write in the body, with where it sits in the control flow. */
export function writeSites(body: string): CallSite[] {
  return flowOf(body).writes;
}

/** Every call in the body that proves the caller is who they claim to be. */
export function authSites(body: string): CallSite[] {
  return flowOf(body).auths;
}

/** Every database read in the body. */
export function readSites(body: string): CallSite[] {
  return flowOf(body).reads;
}

/**
 * Writes this handler can reach with no auth call dominating them: no check at
 * the handler's own level before them, and no check in the block they are about
 * to run in (or one enclosing it) before them.
 *
 * The chain comparison is what makes this more than an ordering check. A check
 * inside `if (a) { … }` does not dominate a write in the sibling block that
 * follows it, even though the check comes first in the text — which is exactly
 * the shape that passed every audit this family ran before it existed.
 */
export function unguardedWrites(body: string): CallSite[] {
  const { auths, writes } = flowOf(body);
  return writes.filter(
    (w) => !auths.some((a) => isPrefix(a.chain, w.chain) && a.index < w.index),
  );
}

/**
 * Reads with no check dominating them — the read-side mirror of the rule above,
 * counted in §8.42 and deliberately NOT made a hard guard.
 *
 * It is not the same question the write rule asks, and treating it as one would
 * produce a number nobody should act on. `const row = await prisma.lead.findUnique(…)`
 * followed by `assertOwns(request, row.workspaceId)` is the family's normal lookup
 * shape: unguarded by this definition, and the row never reaches the caller unless the
 * check passes. Worse, that read *cannot* be guarded by the domination rule as written,
 * because the check needs the row it is asking about — enforcing check-before-read
 * would demand a verdict this scanner has no way to reach. Measured: 91 of 193 reads
 * come back unguarded, 81 of them lookup-then-check, and none of those 81 is inside a
 * response that names the row before the check. The guard that shipped from the same
 * census asks the handler-level question instead — `authSites` against `readSites`.
 */
export function unguardedReads(body: string): CallSite[] {
  const { auths, reads } = flowOf(body);
  return reads.filter(
    (r) => !auths.some((a) => isPrefix(a.chain, r.chain) && a.index < r.index),
  );
}

/**
 * Handlers that read rows and contain no check at all, excluding the ones the
 * calling test already declares public or delegating.
 *
 * This is the rule §8.42 shipped instead of mirroring the write rule, and it is
 * the read-side form of the vulnerability the task named: a GET that returns
 * another workspace's rows with no check anywhere. It is handler-level rather than
 * site-level because a check that runs *after* a lookup protects the row — the
 * lookup is how the handler learns which workspace to ask about — while a handler
 * that reads and never checks has no such excuse.
 *
 * Deliberately stronger than the presence rule it sits beside: that one matches
 * `AUTH_NAME` against the raw body text, so a route whose only "check" is the word
 * inside a string passes it. These call sites come off the tokenized body, so a
 * name in a string or comment is not a check.
 */
export function unauthenticatedReaders(
  handlers: Handler[],
  listed: Record<string, string[]> = {},
): string[] {
  const offenders: string[] = [];
  for (const h of handlers) {
    if ((listed[h.file] ?? []).includes(h.method)) continue;
    const reads = readSites(h.body);
    if (reads.length === 0) continue;
    if (authSites(h.body).length > 0) continue;
    offenders.push(`${h.file} ${h.method} body line ${reads[0].line}: ${reads[0].name}`);
  }
  return offenders;
}

/* ------------------------------------------------------------------ *
 * The other axis: one call's arguments, read out of a whole file.
 * ------------------------------------------------------------------ */

/**
 * `validateBody(body, TABLE)` names its schema by position: argument 1, or
 * argument 2 for `validateItems(value, "name", TABLE)` — the array form needs a word
 * to call the item in the message. Both take trailing options
 * (`{ requireWrite: true }`, `{ max: 50 }`), so the table is found by position and
 * not by being last.
 *
 * This replaced a regex that was wrong twice on the code it was written against
 * (§8.19.4): `[^,()]+` stopped at the first comma *inside an object literal*, so
 * leadgenius' whatsapp route — whose value argument is `{from, body}` across three
 * lines — was read as a table named `from`, and a generic call
 * `validateItems<EmailEvent>(…)` did not match at all, because the pattern expected
 * the paren where the `<` is. One was a loud wrong answer, the other a silent miss.
 * Both belong to the same mistake: matching a call's text instead of reading its
 * arguments. So this balances.
 *
 * And a call whose table is not there is reported as `<unread>` rather than skipped.
 * A scanner that cannot read a call is a finding, not a silence — the six
 * `route-validation.test.ts` copies used to disagree about which of the two it was.
 */
export function schemaArgs(src: string): string[] {
  const code = blankComments(src);
  const found: string[] = [];
  for (const match of code.matchAll(/validate(Body|Items)(?:<[^<>]*>)?\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = splitTopLevel(readArgs(code, open));
    const table = args[match[1] === "Body" ? 1 : 2];
    found.push(table === undefined || table === "" ? "<unread>" : table);
  }
  return found;
}

/**
 * A call's arguments, split at top-level commas, read from its `(` at `open`.
 *
 * Exported for the egress guard, which has to know what a `fetch` was *given*: the
 * first argument is what decides whether an address is a literal in the source,
 * operator configuration, or something a caller supplied. The balancing
 * `schemaArgs` needs for a schema name is the same balancing needed for a URL — an
 * argument containing a comma inside a string, or a second argument that is an
 * object literal across eight lines, must not split into two arguments.
 */
export function callArgs(code: string, open: number): string[] {
  return splitTopLevel(readArgs(code, open));
}

/** The text between a call's `(` (at `open`) and its matching `)`. */
function readArgs(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth === 0) return src.slice(open + 1, i);
    }
  }
  return "<unclosed call>";
}

/** Split on commas that are not inside anything, so an object literal is one piece. */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      current += ch;
      if (ch === "\\") current += args[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/**
 * Comments replaced with spaces, every offset kept: prose is not code, and a rule
 * that reads a file has to be able to tell a call from a sentence about a call
 * without shifting the line numbers out from under the report.
 *
 * String-aware on purpose. A URL in code carries `//`, and a naive `\/\/[^\n]*`
 * blanks from that `//` to the end of the line — erasing the very call the reader is
 * looking for and under-reporting a real write site as silence. So each delimiter is
 * skipped over as literal text, not scanned for comment starts.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(j, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      blank(j, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") { i += 2; continue; }
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Uses of an identifier in code, not in prose and not the declaration itself. A name
 * that only appears inside the doc comment above it is not used — which is how a
 * field table that nothing wires can pass a plain `includes(name)`.
 */
export function countCodeMentions(src: string, name: string): number {
  const code = blankComments(src);
  const uses = code.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
  const declared = code.match(new RegExp(`const\\s+${name}\\b`, "g")) ?? [];
  return uses.length - declared.length;
}

/**
 * Handlers that hand off to a same-file function the scan did not bring back.
 *
 * `collectHandlers` resolves a `return helper(request)` tail call by appending the
 * callee's block (§8.41), and the day that resolution breaks a route can delegate its
 * way out of every rule — the handler reads no body and writes nothing, and the write
 * is in a function nobody scanned. The synthetic tests in `route-scanner.test.ts` pin
 * the resolution itself; this is the version of the question that reads the app's real
 * routes, and it belongs vendored for the same reason the rest of the scanner does: it
 * was written once, in abetanalytics, and the other five were quieter about the case
 * for the two weeks it took to notice.
 *
 * The sources arrive through a reader rather than a directory, so the test that pins
 * this can hand it a fixture instead of scanning whichever app it happens to run in —
 * the same reason the rest of this file's tests are synthetic (§8.44).
 */
export function unresolvedTailCalls(
  handlers: Handler[],
  read: (file: string) => string = (file) => readFileSync(join(process.cwd(), file), "utf8"),
): string[] {
  const hidden: string[] = [];
  for (const h of handlers) {
    const src = read(h.file);
    for (const call of h.body.matchAll(/\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const inner = functionBody(src, call[1]);
      if (inner && !h.body.includes(inner)) hidden.push(`${h.file} ${h.method} -> ${call[1]}()`);
    }
  }
  return hidden;
}
