// #39 — can this instance scrape, and may this address be opened: both answered before
// the job exists, and in the same words everywhere.
//
// Measured against the running app before any of this shipped, in two halves.
//
// The capability half: `playwright@1.64` is a dependency, `package.json` has no
// `postinstall` and nothing on this box has run `npx playwright install chromium`
// (`~/.cache/ms-playwright` does not exist). Three sources were run in a row through
// `POST /api/sources/{id}?action=run`; all three minted a `Job`, all three landed
// `FAILED`, and all three wrote Playwright's five-line banner — the same one captured
// below from the library itself — into `Job.error` *and* into `Source.lastRunError`,
// which is the column the row's "how did my last run go" reads. The door that minted
// each doomed job answered 200 with a `jobId`. Nothing said the one fact a buyer needs
// first: this instance cannot scrape.
//
// The policy half: ten targets were offered to `POST /api/sources` — `file:///etc/passwd`,
// `data:text/html,...`, `javascript:alert(1)`, `about:config`, `http://admin@127.0.0.1:6379/`,
// `http://169.254.169.254/latest/meta-data/`, `http://localhost:5432/`, a bare `/etc/passwd`,
// `localhost:6379/dev.db` and `https://example.com/` as the control. **All ten were accepted
// with a 201**, and the two that were then run failed with the banner above — `file:` and a
// public URL indistinguishable, which is the signature of a check that never ran. The
// app's own egress guard was the policy `src/lib/egress.ts` had been vending for rounds,
// and the scrape path had never called it; `tests/unit/egress-sites.test.ts` could not see
// the gap because its census matches a callee named like `fetch` and this navigation is
// `page.goto`.
//
// So this file pins: the probe's known answers, the banner turned into one sentence, the
// address reader's shapes, the refusal table run through the real `classifyTarget`, and the
// wiring — both write doors and the run door refusing before they write, policy asked
// before capability at both sites, the dead second cron reader gone, and the health door
// stating the capability without depending on it.
//
// Nothing here needs a browser, a database or a network: the probe arrives as an argument,
// and the only DNS in the refusal table is `localhost`, which is a hosts-file lookup.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { blankComments, functionBody } from "./route-handlers";
import {
  BROWSER_INSTALL_COMMAND,
  NO_TARGET_REASON,
  browserMissingReason,
  classifyLaunchFailure,
  scrapeCapability,
  scrapeTarget,
  scrapeTargetProblem,
} from "../../src/lib/scrape-capability";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const srcDir = new URL("../../src", import.meta.url).pathname;
const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (!entry.isDirectory()) return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [file] : [];
    if (entry.name === "generated") return [];
    return srcFiles(file);
  });

/**
 * Verbatim from `chromium.launch({ headless: true })` on this box at playwright@1.64 —
 * `/tmp/opencode/banner39.mts`, run from the worktree so the import resolves. Kept as
 * separate lines because this is the text `Job.error` held, and the point of the round is
 * that an operator can act on the replacement.
 */
const BANNER = [
  "browserType.launch: Executable doesn't exist at /home/opc/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell",
  "╔════════════════════════════════════════════════════════════╗",
  "║ Looks like Playwright was just installed or updated.       ║",
  "║ Please run the following command to download new browsers: ║",
  "║                                                            ║",
  "║     npx playwright install                                 ║",
  "║                                                            ║",
  "║ <3 Playwright Team                                         ║",
  "╚════════════════════════════════════════════════════════════╝",
].join("\n");

const SHELL = "/home/opc/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell";

describe("the capability, from a probe", () => {
  it("says yes when the browser it would launch is on the disk", () => {
    assert.deepEqual(scrapeCapability({ executablePath: "/opt/chrome/chrome", present: true }), {
      runnable: true,
      executablePath: "/opt/chrome/chrome",
    });
  });

  it("names the path and the command when it is not", () => {
    const verdict = scrapeCapability({ executablePath: "/opt/chrome/chrome", present: false });
    assert.equal(verdict.runnable, false);
    assert.match(verdict.reason, /cannot run a scrape/);
    assert.ok(verdict.reason.includes("/opt/chrome/chrome"), `the sentence carries the path the probe missed: ${verdict.reason}`);
    assert.ok(verdict.reason.includes(BROWSER_INSTALL_COMMAND), `and the command that puts it there: ${verdict.reason}`);
  });

  it("does not call an unresolvable path a path", () => {
    const verdict = scrapeCapability({ executablePath: null, present: false });
    assert.equal(verdict.runnable, false);
    assert.ok(!verdict.reason.includes("null"), `the sentence must not print the probe's own placeholder: ${verdict.reason}`);
    assert.ok(!verdict.reason.includes("no browser at"), `there is no path to be missing at: ${verdict.reason}`);
    assert.match(verdict.reason, /does not resolve an executable path/);
  });

  it("gives the operator the same command in both states", () => {
    // A refusal nobody can act on is a support ticket, so the sentence names the fix
    // whether the browser is missing or the resolver gave up.
    assert.ok(browserMissingReason(null).includes(BROWSER_INSTALL_COMMAND));
    assert.ok(browserMissingReason(SHELL).includes(BROWSER_INSTALL_COMMAND));
    assert.notEqual(browserMissingReason(null), browserMissingReason(SHELL), "but they are not the same fact");
  });

  it("is one sentence, not three near-misses", () => {
    // The row, the run door and the health page all state this fact. Three spellings of
    // it is how a changelog ends up promising something the log does not.
    const spelled = browserMissingReason(SHELL);
    const fromProbe = scrapeCapability({ executablePath: SHELL, present: false });
    assert.ok(!fromProbe.runnable);
    assert.equal(fromProbe.reason, spelled, "the probe's answer is the sentence, word for word");
    assert.equal(classifyLaunchFailure(BANNER), spelled, "and so is the banner the launch actually threw");
  });
});

describe("the banner, turned into the sentence", () => {
  it("recognises the real failure and keeps its path", () => {
    const sentence = classifyLaunchFailure(BANNER);
    assert.ok(sentence, "the measured banner is a capability failure");
    assert.ok(sentence!.includes(SHELL), `it names the executable the launch missed: ${sentence}`);
    assert.ok(!sentence!.includes("╔"), `and hands back no box-drawing: ${sentence}`);
  });

  it("tolerates the apostrophe either way it is typed", () => {
    assert.ok(classifyLaunchFailure("browserType.launch: Executable doesn’t exist at /a/b/chrome"));
    assert.ok(classifyLaunchFailure("browserType.launch: Executable doesn't exist at /a/b/chrome"));
  });

  it("leaves an error about the page in its own words", () => {
    // A scrape failure tidied into a capability sentence would be a different lie, and
    // the one that costs more to unwind: the operator installs a browser to fix a timeout.
    for (const message of [
      "page.goto: Timeout 30000ms exceeded.",
      "page.waitForSelector: No node found for selector .lead-card",
      "TypeError: Cannot read properties of undefined (reading 'url')",
    ]) {
      assert.equal(classifyLaunchFailure(message), null, `${message} is not about this instance`);
    }
  });
});

describe("the address a row would open", () => {
  it("reads the url a scrape navigates to, and only that", () => {
    assert.equal(scrapeTarget({ url: "https://example.com/", selectors: {} }), "https://example.com/");
    assert.equal(scrapeTarget({ url: "  " }), "  ", "an empty-ish address is still an address — the policy decides it, not this reader");
  });

  it("says nothing at all for the shapes that name none", () => {
    // `null` here means "there is no target to judge", which is a different answer from
    // "the target is refused"; the doors keep the two apart.
    for (const config of [{}, { url: 42 }, { url: null }, { url: ["https://a.example/"] }, [], null, undefined, "https://example.com/", 42, true]) {
      assert.equal(scrapeTarget(config), null, `${JSON.stringify(config)} holds no address`);
    }
  });

  it("does not ask which type the row claims to be", () => {
    // The sweep mints a `SCRAPE` job for any active source whose cadence matches and the
    // worker reads `job.config.url` whatever the `type` column says, so a guard that only
    // fired on `WEB_SCRAPER` would leave the address the browser actually opens unjudged —
    // and #38's own demo step stores `type: "API"` rows whose config holds a url.
    assert.equal(scrapeTarget({ url: "file:///etc/passwd" }), "file:///etc/passwd");
    assert.ok(!/=== "WEB_SCRAPER"/.test(at("../../src/lib/scrape-capability.ts")), "the module holds no type branch for a door to drift out of");
  });

  it("refuses a scraper with no address in one clause that says why", () => {
    assert.match(NO_TARGET_REASON, /config\.url/);
    assert.ok(!NO_TARGET_REASON.includes("WEB_SCRAPER"), `the sentence is about the promise, not the enum value: ${NO_TARGET_REASON}`);
  });
});

describe("the refusal table, through the policy the doors call", () => {
  // The ten targets #39 offered to `POST /api/sources`, run through the same
  // `classifyTarget` the doors, the worker and the webhook delivery call. Offline by
  // construction: the one name is `localhost`, which is a hosts-file lookup, and the
  // control is a public *literal* so no resolver is involved at all.
  const CASES: Array<[string, RegExp]> = [
    ["file:///etc/passwd", /^file: is not a scheme/],
    ["data:text/html,<h1>hi</h1>", /^data: is not a scheme/],
    ["javascript:alert(1)", /^javascript: is not a scheme/],
    ["about:config", /^about: is not a scheme/],
    ["http://admin@127.0.0.1:6379/", /credentials in it is not an address/],
    ["http://169.254.169.254/latest/meta-data/", /must not be an internal address \(169\.254\.169\.254\)/],
    ["http://localhost:5432/", /internal address|could not be resolved/],
    ["/etc/passwd", /is not an absolute URL/],
    ["localhost:6379/dev.db", /localhost: is not a scheme/],
  ];

  it("refuses every target the door used to store, naming config.url", async () => {
    const saved = process.env.ABET_ALLOW_PRIVATE_TARGETS;
    delete process.env.ABET_ALLOW_PRIVATE_TARGETS;
    try {
      for (const [url, expected] of CASES) {
        const refused = await scrapeTargetProblem({ url });
        assert.ok(refused, `${url} was accepted by this door for every round until now`);
        assert.match(refused, expected, `the refusal for ${url}`);
      }
    } finally {
      if (saved !== undefined) process.env.ABET_ALLOW_PRIVATE_TARGETS = saved;
    }
  });

  it("passes the control, so the refusals above are a policy and not a broken check", async () => {
    assert.equal(await scrapeTargetProblem({ url: "http://93.184.216.34/" }), null, "a public literal address is scrapeable");
    assert.equal(await scrapeTargetProblem({ url: 42 }), null, "and a config with no address is judged by the door, not here");
    assert.equal(await scrapeTargetProblem("nonsense"), null);
  });
});

describe("the wiring, from the source", () => {
  const capability = at("../../src/lib/scrape-capability.ts");
  const scraper = at("../../src/lib/scraper.ts");
  const createDoor = at("../../src/app/api/sources/route.ts");
  const editDoor = at("../../src/app/api/sources/[id]/route.ts");
  const runDoor = blankComments(functionBody(editDoor, "POST_impl")!);
  const health = at("../../src/app/api/health/route.ts");

  it("has the create door refuse before it writes", () => {
    const code = blankComments(createDoor);
    assert.ok(code.includes('from "@/lib/scrape-capability"'), "the door imports the judgement instead of re-spelling it");
    const asked = code.indexOf("scrapeTargetProblem(input.data.config)");
    const written = code.indexOf("prisma.source.create");
    assert.ok(asked > -1 && asked < written, "the address is judged before the row exists");
    assert.match(code.slice(asked, written), /status: 400/);
  });

  it("has the edit door refuse a repoint, and judge the config the row will have", () => {
    const code = blankComments(editDoor);
    const asked = code.indexOf("scrapeTargetProblem(effectiveConfig)");
    const written = code.indexOf("prisma.source.update");
    assert.ok(asked > -1 && asked < written, "a patch that moves `config.url` is the same write as a create");
    assert.match(code.slice(asked, written), /status: 400/);
    // A patch that does not name `config` leaves the stored one, so `config` alone is not
    // the address the row will end up with.
    assert.match(code, /const effectiveConfig = input\.data\.config === undefined \? _owned\.config : input\.data\.config;/);
    assert.match(code, /scrapeTarget\(effectiveConfig\)/);
  });

  it("refuses a scraper with no target on both write doors, in the imported words", () => {
    for (const [where, code, write] of [
      ["create", blankComments(functionBody(createDoor, "POST_impl")!), "prisma.source.create"],
      ["edit", blankComments(functionBody(editDoor, "PATCH_impl")!), "prisma.source.update"],
    ] as const) {
      const refused = code.indexOf("NO_TARGET_REASON");
      assert.ok(refused > -1, `${where} names the empty-config case`);
      assert.ok(code.slice(refused, code.indexOf(write)).includes("status: 400"), `${write} is not reached with an unopenable source`);
    }
    for (const [where, code] of [["create", createDoor], ["edit", editDoor]] as const) {
      assert.match(code, /import \{[^}]*NO_TARGET_REASON[^}]*\} from "@\/lib\/scrape-capability"/, `${where} imports the sentence instead of typing it twice`);
    }
  });

  it("refuses the run door three ways, all before the job exists", () => {
    const created = runDoor.indexOf("prisma.job.create");
    assert.ok(created > -1, "and the door still mints the job when nothing is wrong with it");
    const policy = runDoor.indexOf("scrapeTargetProblem(source.config)");
    const empty = runDoor.indexOf("NO_TARGET_REASON");
    const browser = runDoor.indexOf("readBrowserProbe()");
    assert.ok(policy > -1 && policy < created, "a stored address the policy refuses is refused here too — the row can predate the write doors");
    assert.ok(empty > -1 && empty < created, "and a row with no address mints no doomed job");
    assert.ok(browser > -1 && browser < created, "and a browser-less instance says so instead of handing back a jobId");
    assert.match(runDoor.slice(policy, empty), /status: 400/);
    assert.match(runDoor.slice(empty, browser), /status: 400/);
    assert.match(runDoor.slice(browser, created), /status: 503/);
    assert.ok(!/type === "WEB_SCRAPER"/.test(runDoor.slice(0, created)), "and the run asks no type question — it mints a SCRAPE job whatever the column says");
  });

  it("asks the policy before the capability, at both sites", () => {
    // The refusal that does not depend on which box this is running on must not be able to
    // hide behind the one that does: on this browser-less instance, capability-first would
    // have turned every egress refusal into a hardware complaint and left the guard's
    // verdict unprovable — including the demo leg that runs a stored `file:` config.
    for (const [where, code, target, probe] of [
      ["worker", blankComments(functionBody(scraper, "runScrapeJob")!), 'assertAllowedTarget(config.url, "config.url")', "readBrowserProbe()"],
      ["run door", runDoor, "scrapeTargetProblem(source.config)", "readBrowserProbe()"],
    ] as const) {
      const asked = code.indexOf(target);
      const probed = code.indexOf(probe);
      assert.ok(asked > -1 && probed > asked, `${where}: policy first`);
    }
  });

  it("asserts the address the worker opens, and the page address built out of it", () => {
    const body = blankComments(functionBody(scraper, "runScrapeJob")!);
    assert.equal((body.match(/assertAllowedTarget\(/g) ?? []).length, 2, "the config address and each pagination address");
    assert.ok(body.indexOf('assertAllowedTarget(pageUrl, "config.url")') < body.indexOf("page.goto(pageUrl"), "in the same block, above the navigation");
    assert.ok(!/classifyTarget\(/.test(body), "the worker calls the throwing form, so a pass is not a branch it can fall through");
  });

  it("reads the probe as a path plus a filesystem check, and nothing else", () => {
    // The looking stays out of the pure module; the resolver is what changes between
    // playwright versions, so a throw there is an unresolvable path, not a 500.
    const body = functionBody(scraper, "readBrowserProbe")!;
    assert.match(body, /chromium\.executablePath\(\)/);
    assert.match(body, /existsSync\(/);
    assert.match(body, /catch \{[\s\S]*executablePath = null/);
    assert.match(body, /scrapeCapability\(\{/);
    assert.ok(!/prisma|enqueue|fetch/.test(body), "the probe touches no database, no queue and no wire");
  });

  it("says the capability sentence in exactly one file", () => {
    const offenders = srcFiles(srcDir)
      .filter((file) => /cannot run a scrape/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(srcDir + "/", ""));
    assert.deepEqual(offenders, ["lib/scrape-capability.ts"], "a row, a door and the health page all read this module");
  });

  it("keeps the worker's own error text for an error that is not about the instance", () => {
    const body = blankComments(functionBody(scraper, "runScrapeJob")!);
    assert.match(body, /classifyLaunchFailure\(raw\) \?\? raw/, "the banner becomes the sentence; a timeout stays a timeout");
    assert.ok(body.indexOf("classifyLaunchFailure(raw)") < body.indexOf('status: "FAILED"'), "and before it is stored");
  });

  it("retired the two dead cron readers it found beside the navigation", () => {
    // #38 shipped "one grammar, four doors" and its scan proved that about the *live*
    // paths by looking for the deleted matcher's name. The name was the limit of the scan:
    // this round found two more hand-parsed cadences that never used it, both unreachable
    // — `runScheduledScrapers` in `scraper.ts`, which stuffed the whole `Source.config`
    // object into `config.url`, and `runScheduledExports` in `exporter.ts`, whose reader
    // was `cronParts[1] !== "*"` plus an hour compare and which had a `const now` nothing
    // read. Neither was fixed, because fixing a function no caller has is how a fleet ends
    // up with four schedulers that disagree. Both are deleted, and `matchesSchedule` is the
    // app's only cadence question, which is what #38's sentence said and this scan now backs.
    const offenders = srcFiles(srcDir).filter((file) => /runScheduledScrapers|runScheduledExports|cronParts|proper cron parser/.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders.map((f) => f.replace(srcDir + "/", "")), [], "no definition, no call, no comment promising one");
    assert.ok(!/shouldRunNow|Simplified cron matching/.test(capability), "and this module did not grow a third");
  });

  it("leaves the shipped seed acceptable to the door it now shares", () => {
    // #42's precedent: a door that refuses a shape the repo's own seed writes is a broken
    // seed, not a working guard. `prisma/seed.ts` creates one `WEB_SCRAPER` row, and it has
    // to survive both halves of this round's refusal — an address, and an https one that
    // names no credentials.
    const seed = at("../../prisma/seed.ts");
    const scraper = seed.slice(seed.indexOf('name: "LinkedIn Scraper"'), seed.indexOf('name: "LinkedIn Scraper"') + 900);
    assert.match(scraper, /type: "WEB_SCRAPER"/, "the row this check is about");
    const url = /url:\s*"([^"]+)"/.exec(scraper)?.[1];
    assert.ok(url, "and it names the address a scrape navigates to");
    assert.equal(scrapeTarget({ url }), url, "so the reader finds it");
    assert.match(url, /^https:\/\//, `https, not a scheme this server will refuse: ${url}`);
    assert.ok(!url.includes("@"), "with no userinfo for the policy to refuse");
  });

  it("reports the capability at the health door without letting it decide the status", () => {
    assert.match(health, /scrape: await scrapeStatus\(\)/, "the field is there");
    assert.match(health, /await import\("@\/lib\/scraper"\)/, "asked lazily, so a build without the browser library still answers");
    assert.match(health, /the browser probe could not be asked/, "and reports unknown rather than throwing when the ask itself fails");
    assert.ok(!/ok: false[\s\S]*scrapeStatus/.test(health), "a missing browser is not a down database");
    for (const key of ["ok: true", 'db: "up"', "queues: report.cells", "queueConnection: report.connection", "time: new Date()"]) {
      assert.ok(health.includes(key), `the shape an existing reader depends on is still there: ${key}`);
    }
    // #51 retargeted two of these pins, with the reason: `queues: await queueDepth()` was the
    // all-or-nothing probe, and the door now answers `report.cells` — one cell per queue —
    // with `queueConnection` beside it. The claim being guarded did not move: the queue fact
    // is still reported, still awaited, and still cannot decide the status.
  });
});
