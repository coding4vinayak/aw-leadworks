// #75: six write doors act on what `?action=` says, and all six read it with
// `searchParams.get("action")` — a raw byte compare. Measured on `ff38306` built in this round's
// worktree, served on :3437 over this session's own `leadworks_r75` with a private Redis on 6420,
// two workspaces, keys in `0600` files printed nowhere:
//
//   POST /api/sources/src_r75_notarget?action=run               400 134 "a scrape navigates to the
//                                                                    address in config.url…"
//   POST /api/sources/src_r75_notarget?action=%20run            400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget?action=run%20            400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget?action=%09run            400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget?action=RUN               400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget?action=                  400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget?action                 400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget                          400  26 "Unknown action"
//   POST /api/sources/src_r75_notarget?action=run&action=cancel 400 134 — `cancel` dropped
//   POST /api/sources/src_r75_notarget?action=cancel&action=run 400  26 — `cancel` judged, dropped
//   POST /api/jobs/job_r75_done?action=cancel                   400  39 "Cannot cancel completed job"
//   POST /api/jobs/job_r75_done?action=%20cancel               400  26 "Unknown action"
//   POST /api/jobs/job_r75_pending?action=cancel&action=retry    — WRITES: `cancel` served, the row
//                                                                    left `CANCELLED` (run once, not
//                                                                    in the table the A/B uses)
//   POST /api/exports/exp_r75_file?action=download              200  52 {"downloadUrl":…}
//   POST /api/exports/exp_r75_file?action=retry&action=download 400  41 "Can only retry failed
//                                                                    exports" — `download` dropped
//   POST /api/exports/exp_r75_file?action=%20download           400  26 "Unknown action"
//   POST /api/exports/exp_r75_file?action=download              410  91 "export retired on …" (row
//                                                                    whose retention passed)
//   POST /api/exports/exp_r75_nofile?action=download            404  26 "File not found"
//   POST /api/leads/ld_r75_foreign?action=add-to-list           400  71 "listId is required" (body
//                                                                    judged above the row)
//   POST /api/lead-lists/lst_r75_static?action=add-leads&action=refresh
//                                                               400  28 "leadIds required"
//   POST /api/enrichment-rules/rule_r75_unreadable?action=%20run 400 26 "Unknown action"
//   GET  /api/openapi  /api/exports/{id} post action            "retry — the only action."
//
// So one row answers two different things depending on which of two words the client typed
// first, `%20run` is not `run` for a door that takes `run`, and the map on the same build denies a
// branch that answers `200` with a `downloadUrl`. The refusal a caller hits hardest — `Unknown
// action`, 26 bytes — names neither the word sent nor the words that would have worked.
//
// The rule is the app's own, three times over: `boolParam` trims, drops an empty value, counts a
// word repeated as one word and refuses two different ones; `idFilterParam` does the same to an
// id; `short()` and `stringList` trim before they quote. Nothing here needs a browser, a database
// or a network.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_ACTIONS,
  JOB_ACTIONS,
  LEAD_ACTIONS,
  LEAD_LIST_ACTIONS,
  RULE_ACTIONS,
  SOURCE_ACTIONS,
  actionParam,
  actionWordProblem,
} from "../../src/lib/action-word";
import { openapiOperations } from "../../src/lib/openapi";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** One door's vocabulary: the six constants are the whole set of words this app acts on. */
const DOORS = [
  { name: "sources", constant: "SOURCE_ACTIONS", allowed: SOURCE_ACTIONS, route: "../../src/app/api/sources/[id]/route.ts" },
  { name: "jobs", constant: "JOB_ACTIONS", allowed: JOB_ACTIONS, route: "../../src/app/api/jobs/[id]/route.ts" },
  { name: "exports", constant: "EXPORT_ACTIONS", allowed: EXPORT_ACTIONS, route: "../../src/app/api/exports/[id]/route.ts" },
  { name: "leads", constant: "LEAD_ACTIONS", allowed: LEAD_ACTIONS, route: "../../src/app/api/leads/[id]/route.ts" },
  { name: "lead-lists", constant: "LEAD_LIST_ACTIONS", allowed: LEAD_LIST_ACTIONS, route: "../../src/app/api/lead-lists/[id]/route.ts" },
  { name: "enrichment-rules", constant: "RULE_ACTIONS", allowed: RULE_ACTIONS, route: "../../src/app/api/enrichment-rules/[id]/route.ts" },
];

/** Every spelling of a word measured on the base build, other than the word itself. */
const PADDED = ["%20run", "run%20", "%20run%20", "%09run", "run%0A"];
const WRONG = ["RUN", "Run", "ru n", "rune", "runs", "delete", "pause", '"run"', "cancel", "retry", "download"];

async function refusal(error: NonNullable<ReturnType<typeof actionParam>["error"]>) {
  const status = (error as { status: number }).status;
  const json = (await (error as { json(): Promise<Record<string, string>> }).json()) as Record<string, string>;
  return { status, json };
}

/** The query string as a door would see it: `?action=` on the end of the URL. */
const ask = (query: string, allowed: readonly string[] = SOURCE_ACTIONS) =>
  actionParam(new URL(`http://r75.test/api/sources/x${query}`).searchParams, allowed);

describe("the base read: what `searchParams.get(\"action\")` hands a door", () => {
  it("hands back the padding as part of the word, which is the whole bug", () => {
    for (const spelling of PADDED) {
      const read = new URL(`http://r75.test/api/sources/x?action=${spelling}`).searchParams.get("action");
      assert.notEqual(read, "run", `${spelling} is not the bytes "run": ${JSON.stringify(read)}`);
      assert.equal(read === "run", false, "and this is the only compare the door made");
    }
  });

  it("hands back the FIRST word and the rest disappears, in the caller's order", () => {
    const cancelFirst = new URL("http://r75.test/api/jobs/x?action=cancel&action=retry").searchParams.get("action");
    const retryFirst = new URL("http://r75.test/api/jobs/x?action=retry&action=cancel").searchParams.get("action");
    assert.equal(cancelFirst, "cancel", "one word, and `retry` is gone");
    assert.equal(retryFirst, "retry", "the same two words the other way round, the other word");
    assert.notEqual(cancelFirst, retryFirst, "which is why the order was the request's meaning");
  });

  it("cannot tell an empty value from a name with no value, and calls both nothing", () => {
    const read = ["?action=", "?action", ""].map((query) => new URL(`http://r75.test/api/sources/x${query}`).searchParams.get("action"));
    assert.deepEqual(read, ["", "", null], "`?action=` and `?action` are the same empty string; only an absent name is null");
    assert.equal(read[0], read[1], "and the door compared both to its words, so both were `Unknown action`");
  });
});

describe("actionWordProblem: one door's vocabulary, said in one place", () => {
  it("holds each door's own words, in the order the door serves them", () => {
    assert.deepEqual([...SOURCE_ACTIONS], ["run"]);
    assert.deepEqual([...JOB_ACTIONS], ["retry", "cancel"]);
    assert.deepEqual([...EXPORT_ACTIONS], ["download", "retry"]);
    assert.deepEqual([...LEAD_ACTIONS], ["enrich", "add-to-list"]);
    assert.deepEqual([...LEAD_LIST_ACTIONS], ["add-leads", "remove-leads", "refresh"]);
    assert.deepEqual([...RULE_ACTIONS], ["run"]);
  });

  it("takes each of its own words for the action it names", () => {
    for (const door of DOORS) {
      for (const word of door.allowed) {
        assert.equal(actionWordProblem([word], door.allowed), null, `${door.name}:${word}`);
      }
    }
  });

  it("refuses a word that is not one of the door's, echoing what was sent and naming the set", () => {
    for (const word of WRONG) {
      const problem = actionWordProblem([word], SOURCE_ACTIONS);
      assert.ok(problem !== null, `${word} is not this door's word`);
      assert.ok(problem.includes(`got "${word}"`), `the word sent is echoed: ${problem}`);
    }
    assert.equal(actionWordProblem(["RUN"], JOB_ACTIONS), 'action must be one of retry | cancel, got "RUN"');
    assert.equal(actionWordProblem(["refresh"], SOURCE_ACTIONS), 'action must be one of run, got "refresh"');
  });

  it("refuses to name no word at all, because a door that acts has no default to fall back on", () => {
    // `boolParam` answers `null` here and means "no opinion": a Boolean column has an `@default`.
    // `?action=` has no such thing, and the door already refused it with a 400.
    assert.equal(actionWordProblem([], SOURCE_ACTIONS), "action must be one of run, got nothing");
    assert.equal(actionWordProblem([], JOB_ACTIONS), "action must be one of retry | cancel, got nothing");
  });

  it("refuses two words with their count, both quoted, in the order the caller sent them", () => {
    assert.equal(
      actionWordProblem(["cancel", "retry"], JOB_ACTIONS),
      'action was given 2 words ("cancel", "retry"); this door acts on one of them',
    );
    assert.equal(
      actionWordProblem(["retry", "cancel"], JOB_ACTIONS),
      'action was given 2 words ("retry", "cancel"); this door acts on one of them',
    );
    assert.equal(
      actionWordProblem(["add-leads", "remove-leads", "refresh"], LEAD_LIST_ACTIONS),
      'action was given 3 words ("add-leads", "remove-leads", "refresh"); this door acts on one of them',
    );
  });

  it("refuses a second word even when neither is one of this door's", () => {
    // The count is the caller's news first: two words means the request has two meanings.
    const problem = actionWordProblem(["pause", "stop"], RULE_ACTIONS);
    assert.ok(problem !== null, "a refusal rather than a null");
    assert.ok(problem.startsWith("action was given 2 words"), problem);
  });
});

describe("actionParam: the padding, the repeat and the two-word question", () => {
  it("reads each padded spelling of a word the door takes as that word", () => {
    for (const spelling of PADDED) {
      const asked = ask(`?action=${spelling}`);
      assert.equal(asked.error, null, `${spelling} -> ${JSON.stringify((asked as { action: string | null }).action)}`);
      assert.equal(asked.action, "run", spelling);
    }
  });

  it("reads a tab and a newline as the padding they are, and a space inside the word as the word", () => {
    assert.equal(ask("?action=%09%0Arun").action, "run");
    assert.equal(ask("?action=run%20%09").action, "run", "padding at either end, in any mix");
    assert.notEqual(ask("?action=ru%20n").action, "run", "an inner space is part of the word: `ru n` is not `run`");
  });

  it("counts the same word twice as the one word it is", () => {
    assert.equal(ask("?action=run&action=run").action, "run");
    assert.equal(ask("?action=%20run&run=run&action=run%20").action, "run", "padded and plain are one word");
  });

  it("refuses two different words instead of answering one of them", async () => {
    const asked = ask("?action=run&action=cancel", JOB_ACTIONS);
    assert.equal(asked.action, null);
    const { status, json } = await refusal(asked.error!);
    assert.equal(status, 400, "the status this door already answered a bad word with");
    assert.deepEqual(Object.keys(json), ["error"], "one field, the way the other word doors answer");
    assert.equal(json.error, 'action was given 2 words ("run", "cancel"); this door acts on one of them');
  });

  it("refuses an empty value, an absent value and padding alone the same way", async () => {
    for (const query of ["?action=", "?action", "", "?action=%20", "?action=%20&action="]) {
      const asked = ask(query);
      assert.equal(asked.action, null, query);
      const { status, json } = await refusal(asked.error!);
      assert.equal(status, 400, query);
      assert.equal(json.error, "action must be one of run, got nothing", query);
    }
  });

  it("refuses a word that is not this door's, naming the door's own set", async () => {
    const asked = ask("?action=delete", JOB_ACTIONS);
    const { status, json } = await refusal(asked.error!);
    assert.equal(status, 400);
    assert.equal(json.error, 'action must be one of retry | cancel, got "delete"');
  });

  it("keeps case out of the padding, and says which word would have worked", async () => {
    const asked = ask("?action=RUN");
    assert.equal(asked.action, null, "TRUE is not true at the boolean doors, so RUN is not run here");
    const { json } = await refusal(asked.error!);
    assert.equal(json.error, "action must be one of run, got \"RUN\"");
  });

  it("does not let a second name in the query string answer for the action", () => {
    // `?run=1&action=run` is one word, and `?action=run&run=` is still one word: only `action`
    // is read, so a caller cannot smuggle a second action in under another key.
    assert.equal(ask("?action=run&run=cancel").action, "run");
    assert.equal(ask("?action=run&action=&action=%20").action, "run", "empty spellings name nothing");
  });
});

describe("the six doors read their word through one reader", () => {
  const srcFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) srcFiles.push(path);
    }
  };
  walk(join(process.cwd(), "src"));

  /** A file's code, with its comments gone: this round's own docstring quotes the line it bans. */
  const codeOf = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n");

  it("leaves no door comparing the raw query-string bytes to a literal", () => {
    const raw = srcFiles.filter((path) => codeOf(readFileSync(path, "utf8")).includes('searchParams.get("action")'));
    assert.deepEqual(raw, [], `these files still read the action raw: ${raw.join(", ")}`);
  });

  for (const door of DOORS) {
    it(`${door.name}: reads through actionParam over its own vocabulary and refuses on that line`, () => {
      const code = codeOf(at(door.route));
      assert.match(code, new RegExp(`actionParam\\(searchParams, ${door.constant}\\)`));
      assert.match(code, /const action = asked\.action;/, "the branches read the value the reader returned");
      assert.match(code, /return asked\.error \?\? NextResponse\.json\(\{ error: "Unknown action" \}, \{ status: 400 \}\);/,
        "the refusal is answered where this door answered Unknown action, and the old line survives for a word with no branch");
      assert.ok(!code.includes('searchParams.get("action")'), `${door.name} no longer reads the raw bytes`);
    });

    it(`${door.name}: its vocabulary is exactly the words its branches serve`, () => {
      // `if (action === "…")` only: the exports door also branches on `plan.action === "none"`,
      // which is a different value with a different name.
      const served = [...at(door.route).matchAll(/\bif \(action === "([^"]+)"\)/g)].map((one) => one[1]);
      assert.deepEqual(served, [...door.allowed], `${door.name} serves ${served.join(", ")}`);
      assert.ok(served.length > 0, `${door.name} has no action branch at all`);
    });
  }
});

describe("the map says what the doors do", () => {
  const door = (id: string) => {
    const found = openapiOperations.find((entry) => entry.operation.id === id);
    assert.ok(found !== undefined, `the map has no ${id}`);
    return found!.operation;
  };
  const actionLine = (id: string): string => {
    const pair = (door(id).query ?? []).find(([name]) => name === "action");
    assert.ok(pair !== undefined, `${id} has no action parameter`);
    return pair![1];
  };

  it("names every word each door takes, in its own action description", () => {
    const pairs: [string, readonly string[]][] = [
      ["sources.run", SOURCE_ACTIONS],
      ["jobs.lifecycle", JOB_ACTIONS],
      ["exports.retry", EXPORT_ACTIONS],
      ["leads.enrich", LEAD_ACTIONS],
      ["leadLists.members", LEAD_LIST_ACTIONS],
      ["rules.run", RULE_ACTIONS],
    ];
    for (const [id, allowed] of pairs) {
      const description = actionLine(id);
      for (const word of allowed) {
        assert.ok(description.includes(word), `${id} hides "${word}"`);
      }
      assert.match(description, /Read as one word/, `${id} does not say how the word is read`);
    }
  });

  it("no longer claims the exports door takes one action", () => {
    const description = actionLine("exports.retry");
    assert.ok(description.includes("download"), "the branch that answers 200 with a downloadUrl");
    assert.ok(!description.includes("the only action"), `exports/{id} is not one action: ${description}`);
    assert.ok(door("exports.retry").summary.includes("download"), "and the summary an integrator reads first");
  });

  it("advertises the 400 every door answers for a refused word", () => {
    for (const id of ["sources.run", "jobs.lifecycle", "exports.retry", "leads.enrich", "leadLists.members", "rules.run"]) {
      const said = door(id).responses?.["400"];
      assert.ok(said !== undefined, `${id} answers 400 and does not say so`);
      assert.match(said ?? "", /action/, `${id}'s 400 does not mention the word`);
    }
    assert.ok(door("exports.retry").responses?.["404"] !== undefined, "download on a row with no file");
    assert.ok(door("exports.retry").responses?.["410"] !== undefined, "download on a retired file");
  });
});
