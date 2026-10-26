// #59: the profiles the sweep reads were not addressable by the API at all. Measured on
// `origin/main` (65bd942) on the running app — `:3391` over `leadworks_r59`, Redis 6398, six
// rows seeded the way `prisma/seed.ts` seeds them (`/tmp/opencode/r59_measure.log`,
// `r59_measure_b.log`, `r59_census.sql`):
//
//   GET /api/export-profiles                 404, and the body was the Next.js HTML page
//   GET /api/export-profiles/{id}            404 (POST/PATCH/DELETE on both paths the same)
//   contract paths mentioning a profile      NONE; llms-full.txt lines matching one: 0
//   GET /api/exports?profileId=xp_r59_broken 200 total=0 — a filter by an id no door grants
//   nine sweep minutes                       xp_r59_minute 9 exports, xp_r59_foreign 9,
//                                            xp_r59_broken 0 — with eight
//                                            "Export profile xp_r59_broken is active and
//                                             scheduled, but no minute matches it — day of
//                                             week \"9\" holds 9, outside 0-7" lines in the
//                                            server's log, and the row still reading
//                                            isActive = true
//
// So a weekly drop that will never happen and a weekly drop that happens are the same record
// to every door that existed, and the difference was visible only to someone reading stdout.
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SWEEP_TAKES, profileSkipWarning, profileSweep } from "../../src/lib/export-profile";
import { openapiOperations } from "../../src/lib/openapi";
import { blankComments } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** A Monday 09:00, so `0 9 * * 1` is due and `* * * * *` is always due. */
const MON_9 = new Date("2026-10-26T09:00:30Z");
const MON_10 = new Date("2026-10-26T10:00:00Z");

const row = (over: Partial<{ isActive: boolean; schedule: string | null }> = {}) => ({
  isActive: true,
  schedule: "* * * * *",
  ...over,
});

describe("one row, four states, one verdict", () => {
  it("names every state a profile can be in", () => {
    assert.deepEqual([...SWEEP_TAKES], ["scheduled", "paused", "unscheduled", "unreadable"]);
  });

  it("takes a row whose cadence names this minute", () => {
    const verdict = profileSweep(row(), MON_9);
    assert.equal(verdict.take, "scheduled");
    assert.equal(verdict.takes, true);
    assert.match(verdict.reason, /matches this minute, so the sweep queues an export now/);
    assert.equal(verdict.problem, null);
  });

  it("leaves a readable cadence that does not name this minute alone", () => {
    const verdict = profileSweep(row({ schedule: "0 9 * * 1" }), MON_10);
    assert.equal(verdict.take, "scheduled");
    assert.equal(verdict.takes, false, "the minute does not act on it, and that is not an error");
    assert.match(verdict.reason, /is readable, and the sweep takes it whenever a minute matches/);
    assert.equal(profileSweep(row({ schedule: "0 9 * * 1" }), MON_9).takes, true, "at 09:00 Monday it does");
  });

  it("calls a paused row paused, in the row's own words", () => {
    const verdict = profileSweep(row({ isActive: false }), MON_9);
    assert.equal(verdict.take, "paused");
    assert.equal(verdict.takes, false);
    assert.match(verdict.reason, /^isActive is false, so no minute takes it$/);
  });

  it("calls a row with no cadence unscheduled rather than broken", () => {
    const verdict = profileSweep(row({ schedule: null }), MON_9);
    assert.equal(verdict.take, "unscheduled");
    assert.match(verdict.reason, /^it declares no cadence, so nothing schedules it$/);
    assert.equal(verdict.problem, null);
  });

  it("keeps the grammar's complaint for the cadence it cannot read", () => {
    const verdict = profileSweep(row({ schedule: "0 9 * * 9" }), MON_9);
    assert.equal(verdict.take, "unreadable");
    assert.equal(verdict.takes, false);
    assert.match(verdict.problem!, /day of week "9" holds 9, outside 0-7/);
    assert.match(verdict.reason, /^active and scheduled, but no minute matches it — /);
  });

  it("answers the four states from the four rows this round seeded", () => {
    const seeded = {
      "xp_r59_minute": row(),
      "xp_r59_weekly": row({ schedule: "0 9 * * 1" }),
      "xp_r59_broken": row({ schedule: "0 9 * * 9" }),
      "xp_r59_paused": row({ isActive: false }),
      "xp_r59_nosched": row({ schedule: null }),
    };
    assert.deepEqual(
      Object.entries(seeded).map(([id, one]) => `${id} ${one.schedule ?? "-"} → ${profileSweep(one, MON_9).take}`),
      [
        "xp_r59_minute * * * * * → scheduled",
        "xp_r59_weekly 0 9 * * 1 → scheduled",
        "xp_r59_broken 0 9 * * 9 → unreadable",
        "xp_r59_paused * * * * * → paused",
        "xp_r59_nosched - → unscheduled",
      ],
    );
  });

  it("always hands the reader a sentence, so a UI has nothing to invent", () => {
    for (const one of [row(), row({ isActive: false }), row({ schedule: null }), row({ schedule: "0 9 * * 9" })]) {
      const verdict = profileSweep(one, MON_9);
      assert.ok(verdict.reason.length > 10, verdict.reason);
      assert.equal(typeof verdict.takes, "boolean");
    }
  });
});

describe("the log line is the door's sentence, not a second one", () => {
  it("prints exactly what this runtime printed before the module existed", () => {
    // Measured eight times in `/tmp/opencode/r59_boot_base.log`; a retargeted string would
    // break every grep that has been pointed at it.
    const verdict = profileSweep(row({ schedule: "0 9 * * 9" }), MON_9);
    assert.equal(
      profileSkipWarning("xp_r59_broken", verdict),
      "Export profile xp_r59_broken is active and scheduled, but no minute matches it — day of week \"9\" holds 9, outside 0-7",
    );
  });

  it("is built out of the verdict rather than beside it", () => {
    const warning = at("../../src/lib/export-profile.ts");
    assert.match(warning, /Export profile \$\{id\} is \$\{verdict\.reason\}/);
    const scheduler = at("../../src/lib/scheduler.ts");
    assert.match(scheduler, /console\.warn\(profileSkipWarning\(profile\.id, verdict\)\)/);
    assert.doesNotMatch(scheduler, /console\.warn\(`Export profile/, "no second template for the same line");
  });

  it("never warns for a row it is not skipping for the grammar's sake", () => {
    // The minute only ever reaches the warning when `take` is `unreadable`: a paused row is
    // not fetched at all, and a readable one is matched rather than named.
    for (const one of [row(), row({ isActive: false }), row({ schedule: null })]) {
      assert.notEqual(profileSweep(one, MON_9).take, "unreadable");
    }
  });
});

describe("the doors read the verdict the minute acts on", () => {
  const list = at("../../src/app/api/export-profiles/route.ts");
  const detail = at("../../src/app/api/export-profiles/[id]/route.ts");

  it("both of them import it, so neither can compute its own", () => {
    for (const [door, name] of [[list, "list"], [detail, "detail"]] as const) {
      assert.match(door, /from "@\/lib\/export-profile"/, `${name} goes through the module`);
      assert.match(door, /profileSweep\(/, `${name} calls it`);
      assert.doesNotMatch(door, /scheduleProblem|matchesSchedule/, `${name} does not ask the grammar itself`);
    }
  });

  it("the list is scoped to the key's workspace and paginated like the other read doors", () => {
    assert.match(list, /const workspaceId = await authedWorkspaceId\(request, searchParams\.get\("workspaceId"\)\)/);
    assert.match(list, /const where = \{ workspaceId \}/, "one `where`, used by the page and the count");
    assert.match(list, /prisma\.exportProfile\.findMany\(\{ \.\.\.window/);
    assert.match(list, /prisma\.exportProfile\.count\(\{ where \}\)/);
    assert.match(list, /pageParams\(searchParams, 20\)/);
    assert.match(list, /export const dynamic = "force-dynamic"/);
    assert.match(list, /export const GET = withAuth\(GET_impl\)/);
    assert.match(list, /sweep: profileSweep\(one, now\)/, "the verdict rides with every row");
    assert.match(list, /_count: \{ select: \{ exports: true \} \}/, "and so does what the row has already produced");
  });

  it("the detail door answers a foreign row exactly like a missing one", () => {
    assert.match(detail, /prisma\.exportProfile\.findUnique\(\{\s*where: \{ id \}/);
    assert.match(detail, /if \(!row\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
    assert.match(detail, /await assertOwns\(request, row\.workspaceId\)/, "the app's own 404-for-a-foreign-row check");
    assert.doesNotMatch(detail, /403/, "no answer distinguishes another tenant's row from no row at all");
    assert.match(detail, /take: 5/, "the recent exports are a page, not the crowd");
    assert.match(detail, /export const GET = withAuth\(GET_impl\)/);
  });

  it("both doors print the count under the name the contract uses", () => {
    // Measured on the first fix build: the list answered `exportsCount: null`, because Prisma
    // hands back `_count.exports` and the door spread the row unchanged.
    assert.match(list, /exportsCount: _count\.exports/);
    assert.match(detail, /exportsCount: _count\.exports/);
    assert.match(list, /rows\.map\(\(\{ _count, \.\.\.one \}\)/, "the wrapper is taken off, not left beside the number");
    assert.match(detail, /const \{ exports, _count, \.\.\.rest \} = row/);
  });

  it("and neither of them pretends to write the table", () => {
    for (const door of [list, detail]) {
      assert.deepEqual([...door.matchAll(/export const (POST|PATCH|PUT|DELETE) =/g)].map((m) => m[1]), []);
      assert.doesNotMatch(door, /prisma\.exportProfile\.(create|update|delete)/);
    }
  });

  it("the census: no door writes an ExportProfile, whatever the README promises", () => {
    // `prisma/seed.ts` is the only writer in the repository — measured, and the reason the
    // ids were undiscoverable. This pin holds that shape: it does not claim the feature is
    // finished, it claims the doors that exist are the doors that were described.
    const writers: string[] = [];
    for (const file of [...walk("../../src/app/"), ...walk("../../src/lib/")]) {
      // Comments stripped first: this module's own docstring quotes the call it proves does not exist.
      if (/prisma\.exportProfile\.(create|upsert|update|delete)/.test(blankComments(at(file)))) writers.push(file);
    }
    assert.deepEqual(writers, [], "the doors this round added are read doors; a write door is the next round, not this one");
    assert.match(at("../../prisma/seed.ts"), /exportProfile\.create/, "the demo seed still is the writer this census talks about");
  });
});

describe("the contract advertises the doors, and only what they do", () => {
  const listOp = openapiOperations.find((op) => op.operation.id === "exportProfiles.list")!;
  const detailOp = openapiOperations.find((op) => op.operation.id === "exportProfiles.get")!;

  it("two paths, two GETs, and nothing else", () => {
    assert.equal(listOp.path, "/api/export-profiles");
    assert.equal(listOp.method, "get");
    assert.equal(detailOp.path, "/api/export-profiles/{id}");
    assert.equal(detailOp.method, "get");
    const onThesePaths = openapiOperations.filter((op) => op.path.startsWith("/api/export-profiles"));
    assert.equal(onThesePaths.length, 2, "the spec promises no write door the routes do not have");
  });

  it("the list's 200 names all four verdicts it can print", () => {
    const responses = listOp.operation.responses as Record<string, string>;
    for (const word of SWEEP_TAKES) {
      assert.ok(responses["200"].includes(`\`${word}\``), `200 says what \`${word}\` means: ${responses["200"]}`);
    }
    assert.match(responses["200"], /exportsCount/);
  });

  it("the detail's 404 and 403 are two different answers, as the door gives them", () => {
    const responses = detailOp.operation.responses as Record<string, string>;
    assert.match(responses["404"], /No profile with that id/);
    assert.equal(responses["403"], undefined, "the door gives no 403, so the spec may not promise one");
    assert.match(responses["404"], /another workspace holds/, "and the one answer covers both cases, in the spec's own words");
  });

  it("and the door that filters by these ids says where they come from", () => {
    const exportsList = openapiOperations.find((op) => op.operation.id === "exports.list")!;
    const line = ((exportsList.operation.query as [string, string][]) ?? []).find(([name]) => name === "profileId");
    assert.ok(line, "exports.list still documents profileId");
    assert.match(line![1], /GET \/api\/export-profiles/, "the id a caller can be refused for is an id a door can give");
  });
});

function walk(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const here = `${dir}${entry.name}`;
    if (entry.isDirectory()) walk(`${here}/`, into);
    else if (entry.name.endsWith(".ts")) into.push(here);
  }
  return into;
}
