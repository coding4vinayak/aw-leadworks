// Every exported route handler must either authenticate, delegate to something
// that does, or be on this file's explicit public list.
//
// Why this exists: withAuth does not authenticate. It maps ApiKeyError and P2002
// into responses. A handler exported through it that never calls requireApiKey /
// authedWorkspaceId / assertOwns / getSession is anonymous, and two were — leadworks
// GET /api/webhooks and abetagent GET /api/agents/[id]/runs. Every audit that
// looked for "missing scope" missed them because they were not missing scope,
// they were missing a key check.
//
// The scanner is the part to distrust. It has been wrong three different ways in
// this family: a regex requiring `id:` that never matched the shorthand
// `where: { id }`, a function splitter that took the `{ params }` destructuring
// as the whole body, and a pattern on `export async function GET` that matched
// nothing in a codebase written as `GET_impl`. So this test asserts the scan
// itself: MIN_HANDLERS below, and any handler it cannot resolve is a failure,
// never a silence.
//
// "Somewhere in the body there is a key check" is a weaker rule than the app was
// entitled to. abetagent's `PATCH /api/agents/[id]` had `assertOwns` in its body,
// two conditionals deep, and a `prisma.agent.update` at the handler's own level
// that ran on every path not naming `tools`; the presence test below passed it and
// a request with no Authorization header renamed another workspace's agent. The
// domination tests after it are the rule that catches that shape: for each write,
// some check must be on every path that reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectHandlers, AUTH_NAME, unguardedWrites, writeSites, readSites, unauthenticatedReaders } from "./route-handlers";

// Set from a measured count, deliberately wide. MIN catches a scanner that
// silently stopped finding handlers (the failure mode that hid two anonymous
// routes for this long); MAX catches one that started double-counting.
const MIN_HANDLERS = 46;
const MAX_HANDLERS = 76;

// Anything that proves the caller is who they claim to be lives in ./route-handlers.ts
// as AUTH_NAME — one list, shared with the domination tests below. A check that
// counts for one rule and not the other is the gap this family has been caught in.

/**
 * Handlers that are public on purpose, with the thing that makes that safe.
 * Adding to this list is the review step: an empty-body check is not a reason.
 */
const PUBLIC: Record<string, string[]> = {
  // Liveness for the process manager and the hub. Reads no tenant row:
  // `SELECT 1` and nothing else.
  "src/app/api/health/route.ts": ["GET"],
};

/** Handlers that authenticate by calling something outside the body. */
const DELEGATES: Record<string, string[]> = {};

test("the scanner sees every handler it claims to", () => {
  const handlers = collectHandlers();
  const key = `${MIN_HANDLERS} handlers is the floor`;
  assert.ok(handlers.length >= MIN_HANDLERS, key);
  assert.ok(handlers.length <= MAX_HANDLERS, `${handlers.length} handlers exceeds ${MAX_HANDLERS} — the scanner is double-counting`);
});

test("every exported handler authenticates, delegates, or is listed public", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    const listed = (PUBLIC[h.file] ?? []).includes(h.method);
    const delegated = (DELEGATES[h.file] ?? []).includes(h.method);
    if (listed || delegated) continue;
    if (AUTH_NAME.test(h.body)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers with no key check and no entry in PUBLIC:\n  ${offenders.join("\n  ")}`);
});

test("the write scanner sees writes, not just handlers", () => {
  let writes = 0;
  for (const h of collectHandlers()) writes += writeSites(h.body).length;
  // Measured on leadworks's routes when this rule was written: 32 writes. The
  // floor exists so that a WRITE_NAME regex which stopped matching cannot turn the
  // domination test below into a vacuous pass.
  assert.ok(writes >= 20, `only ${writes} writes found — the write pattern has rotted, not the app`);
});

// No PUBLIC exemption here, unlike the presence test: a handler that is public by
// design still has to explain why a request can reach its writes without a key.
test("no write is reachable without a check that dominates it", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    for (const w of unguardedWrites(h.body)) {
      offenders.push(`${h.file} ${h.method} body line ${w.line}: ${w.name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `writes that a request can reach before any key check:\n  ${offenders.join("\n  ")}`,
  );
});

// §8.42, the read side. Counting first is what made this a handler-level rule rather
// than a mirror of the one above: of 193 reads across the six apps, 91 have no
// dominating check, and 81 of those are the lookup-then-check idiom a mirrored rule
// would have condemned — `assertOwns(request, row.workspaceId)` cannot run before the
// read that produces `row`. What a route must not do is read at all in a handler with
// no check anywhere in it.
test("the read scanner sees reads, not just handlers", () => {
  let reads = 0;
  for (const h of collectHandlers()) reads += readSites(h.body).length;
  // Measured on this app's routes when the rule was written: 48 reads. The floor
  // exists so that a READ_NAME pattern which stopped matching cannot turn the rule
  // below into a vacuous pass, which is the same reason the write floor is there.
  assert.ok(reads >= 8, `only ${reads} reads found — the read pattern has rotted, not the app`);
});

// No new excuse list. Every handler here that reads with no check anywhere is already
// on PUBLIC, which is what saying "this route is anonymous" is for; DELEGATES counts
// too, because a handler that authenticates by calling something outside its body
// reads the same way it writes.
test("a handler that reads rows checks the caller somewhere, or is listed public", () => {
  const offenders = unauthenticatedReaders(collectHandlers(), { ...PUBLIC, ...DELEGATES });
  assert.deepEqual(
    offenders,
    [],
    `handlers that read the database with no check anywhere in them:\n  ${offenders.join("\n  ")}`,
  );
});

// The rule above is only as good as the tokenizer underneath it, and a tokenizer
// that said "guarded" for everything would pass it. These bodies are the shapes
// leadworks's real handlers turn out to contain, each with its opposite, so both
// directions are pinned. `handler()` builds the one brace block the rule compares
// against.
const handler = (...lines: string[]): string => `{\n${lines.join("\n")}\n}`;
const CHECK = "  await assertOwns(request, row.workspaceId);";
const WRITE = "  await prisma.lead.update({ where: { id } });";

test("a check at the handler's own level guards a later write", () => {
  assert.deepEqual(unguardedWrites(handler(CHECK, WRITE)), []);
});

test("a check in a conditional does not guard a write outside it", () => {
  const bodies = [
    handler("  if (tools !== undefined) {", CHECK, "  }", WRITE),
    handler("  if (tools !== undefined) {", "    if (unknown.length > 0) {", CHECK, "    }", "  }", WRITE),
    // A check in one sibling branch cannot guard a write in the next.
    handler("  if (a) {", CHECK, "  }", "  if (b) {", WRITE, "  }"),
  ];
  for (const body of bodies) {
    const offenders = unguardedWrites(body);
    assert.equal(offenders.length, 1, `expected one unguarded write in:\n${body}`);
    assert.equal(offenders[0].name, "prisma.lead.update");
  }
});

test("a write that runs before the check is unguarded at any depth", () => {
  assert.equal(unguardedWrites(handler(WRITE, CHECK)).length, 1);
  assert.equal(unguardedWrites(handler("  if (a) {", WRITE, CHECK, "  }")).length, 1);
  assert.deepEqual(unguardedWrites(handler("  if (a) {", CHECK, WRITE, "  }")), []);
});

test("a check and a write in the same block guard each other", () => {
  // The shapes the family already relies on: `try`, and an `?action=` dispatcher
  // where every branch checks before it writes. A rule written as "depth 1 only"
  // would fail both.
  assert.deepEqual(unguardedWrites(handler("  try {", CHECK, WRITE, "  }")), []);
  assert.deepEqual(
    unguardedWrites(
      handler(
        "  if (action === 'pause') {",
        "    const row = await prisma.lead.findUnique({ where: { id } });",
        CHECK,
        WRITE,
        "  }",
        "  if (action === 'rename') {",
        "    const row = await prisma.lead.findUnique({ where: { id } });",
        CHECK,
        WRITE,
        "  }",
      ),
    ),
    [],
  );
});

test("braces inside strings, comments and regexes are not blocks", () => {
  const inString = handler('  const note = "assertOwns( { }";', CHECK, "  await prisma.lead.update({ data: { note } });");
  assert.deepEqual(unguardedWrites(inString), []);
  const inComment = handler("  // assertOwns( {", "  /* if (x) { */", CHECK, WRITE);
  assert.deepEqual(unguardedWrites(inComment), []);
  const inRegex = handler("  if (/assertOwns{/.test(h)) {", CHECK, "  }", WRITE);
  assert.equal(unguardedWrites(inRegex).length, 1);
});

test("writeSites finds the writes that unguardedWrites sorts", () => {
  const sites = writeSites(handler("  if (a) {", WRITE, "  }", "  await prisma.lead.delete({ where: { id } });"));
  assert.deepEqual(sites.map((s) => s.name), ["prisma.lead.update", "prisma.lead.delete"]);
  assert.equal(writeSites(handler("  await prisma.lead.findUnique({ where: { id } });")).length, 0);
});

test("PUBLIC and DELEGATES name handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale: string[] = [];
  for (const [file, methods] of [...Object.entries(PUBLIC), ...Object.entries(DELEGATES)]) {
    for (const method of methods) if (!seen.has(`${file} ${method}`)) stale.push(`${file} ${method}`);
  }
  assert.deepEqual(stale, [], `listed as public but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});
