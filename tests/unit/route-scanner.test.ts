// The scanner's own behaviour, pinned on synthetic source rather than on whatever
// routes an app happens to have.
//
// Vendored with `route-handlers.ts` for the reason that file exists at all: six
// hand-copied guards drift, and this one has a second excuse. Every app's route set
// is different, so a test written against the real handlers can only be as
// non-vacuous as the app is — abetflow has one handler that delegates, the other
// five have none, and a scanner that stopped resolving delegations would fail one
// app's suite and leave the rest green while telling them nothing. Synthetic input
// is the same claim with no route to wait for.
//
// What is being pinned, in order: that a tail call into a same-file function brings
// that function's writes into the scanned body; that the write it reveals is then
// judged by the domination rule like any other; that the scan terminates and adds
// each block once when two functions return each other; what the read side's rule
// does and does not condemn; and what the scan still cannot see, stated as an
// assertion so the next person to hit it finds a sentence about it instead of a
// surprise. The last section is the other axis — one call's arguments, and one
// identifier's uses, both read out of a whole file — which arrived with §8.44 and is
// pinned here rather than in the app that found the two shapes the regex missed. §8.45
// added the general form of the same read — `callArgs`, for a call that is not a
// validation — pinned against the punctuation a URL is allowed to contain, because that
// is the argument the egress guard has to read.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_NAME,
  type Handler,
  authSites,
  blankComments,
  callArgs,
  countCodeMentions,
  functionBody,
  readSites,
  resolveDelegation,
  schemaArgs,
  unauthenticatedReaders,
  unguardedReads,
  unguardedWrites,
  unresolvedTailCalls,
  writeSites,
} from "./route-handlers";

/** A handler that is nothing but a call into the helper below it. */
const DELEGATING = `
async function trigger(request: Request) {
  if (!request.public) {
    await verifySignature(request);
  }
  const row = await prisma.execution.create({ data: { input: null } });
  return NextResponse.json({ id: row.id });
}

export async function POST(request: Request) {
  return trigger(request);
}
`;

const outerOf = (src: string, name: string): string => {
  const outer = functionBody(src, name);
  assert.ok(outer !== null, `no function ${name}() in the fixture`);
  return outer;
};

test("the outer block of a delegating handler holds no write at all", () => {
  // The blind spot, measured: this is what the guard used to scan, and it is why a
  // route that delegates could not fail a rule that reads its body.
  assert.equal(writeSites(outerOf(DELEGATING, "POST")).length, 0);
});

test("resolving the tail call brings the helper's write into scope", () => {
  const outer = outerOf(DELEGATING, "POST");
  const resolved = resolveDelegation(DELEGATING, outer, ["POST"]);
  assert.deepEqual(
    writeSites(resolved).map((w) => w.name),
    ["prisma.execution.create"],
    "the helper's write is not visible after resolution — the auth guard is one line deep again",
  );
});

test("a check inside a branch still does not dominate the delegated write", () => {
  // Resolution is not a way of making writes disappear: the block that comes back
  // is judged by the same rule as the handler's own, and `verifySignature` behind
  // an `if` guards nothing that follows the `if`.
  const resolved = resolveDelegation(DELEGATING, outerOf(DELEGATING, "POST"), ["POST"]);
  assert.equal(unguardedWrites(resolved).length, 1);
  const hoisted = DELEGATING.replace(
    "  if (!request.public) {\n    await verifySignature(request);\n  }\n",
    "  await verifySignature(request);\n",
  );
  assert.notEqual(hoisted, DELEGATING, "the fixture moved and this test's replacement no longer applies");
  assert.equal(unguardedWrites(resolveDelegation(hoisted, outerOf(hoisted, "POST"), ["POST"])).length, 0);
});

test("two functions that return each other are each appended once", () => {
  const src = `
async function a(request: Request) {
  await prisma.workflow.update({ where: { id: 1 } });
  return b(request);
}
async function b(request: Request) {
  return a(request);
}
export async function POST(request: Request) {
  return a(request);
}
`;
  const resolved = resolveDelegation(src, outerOf(src, "POST"), ["POST"]);
  assert.deepEqual(
    writeSites(resolved).map((w) => w.name),
    ["prisma.workflow.update"],
    "a cycle duplicated a block — the domination test would report the same write twice",
  );
});

test("a tail call out of the file adds nothing, and says so by not throwing", () => {
  const src = `
export async function POST(request: Request) {
  return runIt(request);
}
`;
  const resolved = resolveDelegation(src, outerOf(src, "POST"), ["POST"]);
  assert.equal(resolved, outerOf(src, "POST"));
});

/**
 * The hole this scanner still has, kept honest by asserting it rather than by
 * nobody looking. A helper declared as a module-level `const NAME = async (…) => {…}`
 * is not a `function` and so does not resolve. Measured across the six apps, no
 * route file declares one: the only arrow a tail call names is abetapi's `refused`,
 * and that closure is written inside the handler body that calls it, so its own
 * statements are already in the scanned text. The day a route file grows a
 * module-level arrow helper that a handler returns, the auth guard sees a handler
 * with no writes in it — and the test below is what fails first, because it is the
 * one place that states the shape out loud.
 */
test("a module-level arrow helper is NOT resolved — this is the known blind spot", () => {
  const src = `
const runIt = async (request: Request) => {
  await prisma.execution.create({ data: {} });
  return NextResponse.json({ ok: true });
};

export async function POST(request: Request) {
  return runIt(request);
}
`;
  const resolved = resolveDelegation(src, outerOf(src, "POST"), ["POST"]);
  assert.equal(
    writeSites(resolved).length,
    0,
    "an arrow helper resolved after all: delete this test and widen the scanner's doc comment to cover both shapes",
  );
});

// ------------------------------------------------------------------ the read side
//
// §8.42 counted the read side and shipped a handler-level rule rather than a
// site-level one. The four tests below are the difference between those two rules,
// stated on input no app has to grow a route for: the lookup-then-check shape the
// weaker rule would have condemned, the bare reader the shipped rule condemns, and
// the excuse list doing the excusing.
const block = (...lines: string[]): string => `{\n${lines.join("\n")}\n}`;
const reader = (file: string, body: string): Handler => ({ file, method: "GET", body });

const LOOKUP = "  const row = await prisma.lead.findUnique({ where: { id } });";
const FIND_MANY = "  const rows = await prisma.lead.findMany({ where: { status } });";
const RAW = "  const [{ n }] = await prisma.$queryRaw`SELECT COUNT(*) as n`;";
const CHECK = "  await assertOwns(request, row.workspaceId);";
const ANSWER = "  return NextResponse.json(row);";
const NOT_FOUND = "  if (!row) return NextResponse.json({}, { status: 404 });";

test("a lookup that a later check protects is not an offender", () => {
  // The decision, in code. `unguardedReads` flags this read — nothing dominating it
  // ran first — and the family's handlers are full of that shape because the check
  // needs the row it asks about. So the shipped rule asks the handler-level question
  // and answers "there is a check in here".
  const body = block(LOOKUP, NOT_FOUND, CHECK, ANSWER);
  assert.equal(readSites(body).length, 1);
  assert.equal(unguardedReads(body).length, 1);
  assert.deepEqual(unauthenticatedReaders([reader("src/app/api/leads/[id]/route.ts", body)]), []);
});

test("a handler that reads and checks nothing is named with the read that gave it away", () => {
  const offenders = unauthenticatedReaders([reader("src/app/api/leads/route.ts", block(FIND_MANY, ANSWER))]);
  assert.equal(offenders.length, 1, `the bare reader was not flagged:\n${block(FIND_MANY, ANSWER)}`);
  assert.match(offenders[0], /src\/app\/api\/leads\/route\.ts GET/);
  assert.match(offenders[0], /prisma\.lead\.findMany/);
});

test("the excuse list excuses, and only the file and method it names", () => {
  // Measured on the real routes: every one of the ten reads with no check anywhere
  // in its handler belongs to a handler already on `PUBLIC` — the six health probes
  // and abetflow's two webhook methods. Those are the six apps paying for a rule
  // they opted into; the list, not the scanner, is what lets them through.
  const body = block(RAW);
  assert.equal(readSites(body).length, 1, "`prisma.$queryRaw` as a tagged template is not matched");
  const file = "src/app/api/health/route.ts";
  assert.equal(unauthenticatedReaders([reader(file, body)]).length, 1, "unlisted, the bare reader must be named");
  assert.deepEqual(unauthenticatedReaders([reader(file, body)], { [file]: ["GET"] }), []);
  assert.equal(unauthenticatedReaders([reader(file, body)], { [file]: ["POST"] }).length, 1,
    "listing a method that does not read excused the one that does");
});

test("a check that exists only inside a string is not a check", () => {
  // The presence rule beside this one matches `AUTH_NAME` against the raw body text,
  // so it is satisfied here — that is the assertion above, not an accident of this
  // fixture. The read rule's calls come off the tokenized body, which makes it the
  // stricter of the two, and is why a route cannot answer it by mentioning a check.
  const body = block('  const note = "assertOwns(request, row.workspaceId)";', LOOKUP, ANSWER);
  assert.match(body, AUTH_NAME, "the presence rule no longer sees this fixture as authenticated — the two rules are not measuring the same thing any more");
  assert.equal(authSites(body).length, 0);
  assert.equal(unauthenticatedReaders([reader("src/app/api/notes/route.ts", body)]).length, 1);
});

// --------------------------------------------------------- the argument axis
//
// Everything above asks where calls sit inside one handler body. `schemaArgs` asks a
// different question of a whole file: what does this call pass. It moved out of
// leadgenius's `route-validation.test.ts` in §8.44 with the claim that made it
// general — that file's regex mis-read four of the twenty-one calls in the app it was
// written against, and the other five apps each carried a copy of the same regex
// reading the same shapes differently. The two failures are the two interesting ones,
// so both are fixtures here rather than routes somebody has to grow.
const CALL_SHAPES = [
  // A generic: the regex expected `(` where the `<` sits, so this did not match at all.
  'const a = validateItems<EmailEvent>(events, "events", INBOUND_EMAIL_EVENT);',
  // Multi-line, with an object literal as the *value* argument. The regex's `[^,()]+`
  // stopped at the first comma inside that literal and read `from` as the table — a
  // table that does not exist, reported loudly as one that was not declared.
  "const b = validateBody(",
  "  { messageId: body.MessageSid, from: body.From, content: body.Body },",
  "  INBOUND_MESSAGE_EVENT,",
  ");",
  // Trailing options on both forms: the table is found by position, not by being last.
  "const c = validateBody(body, CONTACT_PATCH, { requireWrite: true });",
  'const d = validateItems(steps, "stepsConfig", SEQUENCE_STEP, { max: 50 });',
  "// validateBody(body, NOT_A_TABLE) is prose, and must not be read as a call",
].join("\n");

test("schemaArgs reads every call shape the regex got wrong, and no prose", () => {
  assert.deepEqual(
    schemaArgs(CALL_SHAPES),
    ["INBOUND_EMAIL_EVENT", "INBOUND_MESSAGE_EVENT", "CONTACT_PATCH", "SEQUENCE_STEP"],
    "every call in the file, its table, and nothing from a comment",
  );

  // The two shapes this test exists to forbid have to come *back*, not be skipped: a
  // scanner that cannot see an inline schema or a call with no table argument at all
  // would leave the rule that reads this written but unenforceable.
  const inline = schemaArgs('const e = validateBody(raw, { name: { kind: "text" } });');
  assert.equal(inline.length, 1);
  assert.ok(inline[0].startsWith("{"), `an inline schema has to read as one, got ${JSON.stringify(inline)}`);
  assert.deepEqual(schemaArgs("const f = validateBody(raw);"), ["<unread>"], "a call with no table argument");
});

/**
 * `collectHandlers` resolves a same-file tail call by appending the callee's block,
 * so the real routes come back clean and this tripwire reads as a no-op. That is
 * exactly why it needs a synthetic case: the fixture below is what a handler looks
 * like to a scanner that stopped resolving — the outer block alone, with the write in
 * a function nobody read. One assertion per direction, plus the out-of-file call that
 * must *not* be reported, since there is no block to bring back.
 */
test("the tail-call tripwire fires on an unresolved handler, and only on one", () => {
  const file = "src/app/api/triggers/[id]/run/route.ts";
  const sources = () => DELEGATING;
  const handler = (body: string): Handler => ({ file, method: "POST", body });

  const outer = outerOf(DELEGATING, "POST");
  assert.deepEqual(unresolvedTailCalls([handler(outer)], sources), [`${file} POST -> trigger()`]);

  const resolved = resolveDelegation(DELEGATING, outer, ["POST"]);
  assert.deepEqual(unresolvedTailCalls([handler(resolved)], sources), []);

  const outside = `
export async function POST(request: Request) {
  return runIt(request);
}
`;
  assert.deepEqual(unresolvedTailCalls([handler(outerOf(outside, "POST"))], () => outside), []);
});

/**
 * `countCodeMentions` is the one piece of this round whose failure a real app cannot
 * show. The orphan rule in every `route-validation.test.ts` asks it whether a table is
 * used anywhere in `fields.ts`, and measuring the mutant told us the answer: replacing
 * the subtraction with the raw count fails nothing in any of the six apps — it makes the
 * rule blind, because a declaration is always a mention and so no table can ever be
 * reported unused. A guard that goes quiet rather than wrong needs a fixture that has a
 * declaration in it, which is the only way to separate "used" from "declared".
 */
const FIELDS_FIXTURE = `
/**
 * SEQUENCE_STEP is the array form; the steps route validates against it.
 */
export const SEQUENCE_STEP = { name: { kind: "text" } };
export const CONTACT = { email: { kind: "text" } };

// CONTACT is re-exported under the old name for one more release.
const read = () => CONTACT;
`;

test("countCodeMentions counts uses, and not the declaration or the prose", () => {
  assert.equal(
    countCodeMentions(FIELDS_FIXTURE, "SEQUENCE_STEP"),
    0,
    "a table that is declared and written about but never used read as used — the orphan rule cannot fire",
  );
  assert.equal(countCodeMentions(FIELDS_FIXTURE, "CONTACT"), 1, "the one real use was not counted");
  assert.equal(countCodeMentions(FIELDS_FIXTURE, "SOMETHING_ELSE"), 0);
});

test("blankComments erases a comment, not the // inside a URL string", () => {
  const src = [
    "// fetch(x) in prose is not a call",
    'const res = await fetch("https://api.test/health", { method: "GET" });',
    "/* fetch(y) block prose */",
  ].join("\n");
  const code = blankComments(src);
  assert.ok(!code.includes("not a call"), "a line comment survived blanking");
  assert.ok(!code.includes("block prose"), "a block comment survived blanking");
  assert.ok(
    code.includes('fetch("https://api.test/health"'),
    "the // inside the URL was read as a comment and erased the call that followed it on the line",
  );
  assert.equal(code.split("\n").length, src.split("\n").length, "offsets shifted out from under the report");
});

/**
 * `callArgs` is the general form of the read above: any call, not only a validation.
 *
 * It exists because the egress guard has to pull the *address* out of a
 * `fetch(url, { … })`, and a URL is the one argument certain to contain both a comma
 * and a parenthesis. Splitting on every comma, or ending the call at the first `)`
 * anywhere in the text, each put the end of the first argument in the wrong place —
 * and an address judged as a fragment is a policy decision made about a string nobody
 * wrote.
 */
function firstArg(code: string): string {
  const call = /[Ff]etch\s*\(/.exec(code);
  assert.ok(call, `the fixture has no fetch call in it: ${code}`);
  const open = (call.index ?? 0) + call[0].length - 1;
  return callArgs(code, open)[0] ?? "<none>";
}

test("callArgs splits a fetch by the punctuation a URL is allowed to contain", () => {
  assert.equal(
    firstArg('const a = fetch(`https://api.test/v1?q=${encodeURIComponent(company)}&x=1,2`, { method: "GET" });'),
    '`https://api.test/v1?q=${encodeURIComponent(company)}&x=1,2`',
    "the comma inside the template and the `)` of the interpolated call each ended the first argument early",
  );
  assert.equal(
    firstArg('const b = fetch(url, {\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify({ note: "a, comma and (parens)" }),\n});'),
    "url",
    "an object literal spanning several lines is one argument, not three",
  );
  assert.equal(firstArg('const c = fetch("https://api.test/a,b", init);'), '"https://api.test/a,b"');
  // The alias is read by the same helper — `doFetch` is how abetflow's executor calls
  // an injected fetch, and a guard that only matches the literal word `fetch` cannot
  // see that site at all.
  assert.equal(firstArg('const e = doFetch(hook.url, { method: "POST" });'), "hook.url");
  // A call that never closes is reported rather than guessed at.
  assert.equal(firstArg("const d = fetch(url, {"), "<unclosed call>");
});
