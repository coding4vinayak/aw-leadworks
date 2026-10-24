// #46: `GET /api/lead-lists/{id}` did not read its own query string. Measured on the
// running app before this round, on a static list of 100 imported leads, twelve
// spellings of "give me less than the row" — `?fields=email,score`, `?select=email`,
// `?include=email`, `?fields[]=email`, `?fields=a&fields=b`, `?fields=`,
// `?fields=nonsense` — each answered 200 with 171,720 bytes and 33 keys per member
// lead. `/tmp/opencode/r46_probe.mjs` holds the run; the numbers are quoted in
// src/lib/list-fields.ts. A caller who wanted an email and a score was handed the
// whole row, and a caller who named a column the product does not have was handed
// the whole row instead of a refusal.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fieldsParam, leadSelect } from "../../src/lib/list-fields";
import { LEAD_EXPORT_FIELDS, LEAD_FIELD_PICK, EXPORT_CREATE } from "../../src/lib/fields";
import { validateBody } from "../../src/lib/validate";
import { blankComments, functionBody, resolveDelegation } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const q = (query: Record<string, string>) => new URLSearchParams(query);
/** The 400's own body, read the way the door's caller would read it. */
async function refusal(input: { ok: boolean; error?: undefined | { status: number; json(): Promise<unknown> } }) {
  assert.equal(input.ok, false, "this helper is for the answer that refuses");
  const error = input.error as { status: number; json(): Promise<Record<string, unknown>> };
  return { status: error.status, json: await error.json() };
}
/** What the door would hand Prisma for this query string: a list, `null`, or a Response. */
const pick = (query: string) => {
  const asked = fieldsParam(new URLSearchParams(query));
  if (asked === null) return null;
  const input = validateBody({ fields: asked }, LEAD_FIELD_PICK);
  return input.ok ? input.data.fields : input.error;
};

describe("fieldsParam: the difference between not asking and asking for nothing", () => {
  it("says null when the request never mentioned fields", () => {
    for (const query of ["", "?limit=10", "?select=email", "?include=email"]) {
      assert.equal(fieldsParam(new URLSearchParams(query)), null, query);
    }
  });

  it("does not treat a neighbouring parameter as a column list", () => {
    assert.equal(fieldsParam(q({ select: "email" })), null);
    assert.equal(fieldsParam(q({ fields_: "email" })), null);
  });

  it("splits a comma list", () => {
    assert.deepEqual(fieldsParam(new URLSearchParams("?fields=email,score")), ["email", "score"]);
  });

  it("takes every repeated fields parameter, not the first", () => {
    assert.deepEqual(fieldsParam(q({ fields: "email" })), ["email"]);
    assert.deepEqual(fieldsParam(new URLSearchParams("fields=email&fields=score")), ["email", "score"]);
    assert.deepEqual(
      fieldsParam(new URLSearchParams("fields=email,score&fields=status")),
      ["email", "score", "status"],
      "a repeated parameter and a comma list in one request are one list",
    );
  });

  it("keeps `?fields[]=` out, because that is a different parameter's name", () => {
    assert.equal(fieldsParam(q({ "fields[]": "email" })), null);
  });

  it("hands an empty value to the engine rather than deciding here", () => {
    assert.deepEqual(fieldsParam(new URLSearchParams("?fields=")), [""]);
    assert.deepEqual(fieldsParam(new URLSearchParams("?fields=email,,score")), ["email", "", "score"]);
  });

  it("leaves the padding on the entry — trimming is the validator's job, done once", () => {
    assert.deepEqual(fieldsParam(new URLSearchParams("?fields=%20email%20")), [" email "]);
  });
});

describe("the judgement is the export door's judgement, against one vocabulary", () => {
  it("reads its names from LEAD_EXPORT_FIELDS rather than a copy", () => {
    assert.equal(LEAD_FIELD_PICK.fields.values, LEAD_EXPORT_FIELDS, "the same array, so one edit moves both doors");
    assert.equal(EXPORT_CREATE.fields.values, LEAD_FIELD_PICK.fields.values);
  });

  it("accepts a list of real columns and keeps the order the caller wrote", () => {
    const input = validateBody({ fields: ["score", "email", "company"] }, LEAD_FIELD_PICK);
    assert.equal(input.ok, true);
    if (input.ok) assert.deepEqual(input.data.fields, ["score", "email", "company"]);
  });

  it("treats a column asked twice as one column", () => {
    const input = validateBody({ fields: ["email", "email"] }, LEAD_FIELD_PICK);
    if (input.ok) assert.deepEqual(input.data.fields, ["email"]);
    else assert.fail("a repeat is not an error");
  });

  it("trims the padding off a name", () => {
    const input = validateBody({ fields: [" email ", "score"] }, LEAD_FIELD_PICK);
    if (input.ok) assert.deepEqual(input.data.fields, ["email", "score"]);
    else assert.fail("padding is not part of the name");
  });

  it("refuses a name that is not a column, and says which entry it was", async () => {
    const { status, json } = await refusal(validateBody({ fields: ["email", "nonsense"] }, LEAD_FIELD_PICK));
    assert.equal(status, 400);
    const fields = json.fields as Record<string, string>;
    assert.match(fields["fields[1]"], /must be one of/);
    assert.match(String(json.error), /nonsense/, "the refusal names the caller's own word");
    assert.match(String(json.error), /linkedinUrl/, "and prints the vocabulary it was judged against");
  });

  it("refuses `?fields=`: a request that names nothing is not a request for the row", async () => {
    const { status, json } = await refusal(validateBody({ fields: [""] }, LEAD_FIELD_PICK));
    assert.equal(status, 400);
    assert.match(String(json.error), /non-empty string/);
  });

  it("refuses a capitalisation of a real column, which is a different name", () => {
    for (const name of ["Email", "EMAIL", "Score"]) {
      assert.equal(validateBody({ fields: [name] }, LEAD_FIELD_PICK).ok, false, name);
    }
  });

  it("caps the list where every other list in the API is capped", async () => {
    const many = Array.from({ length: 101 }, () => "email");
    const { json } = await refusal(validateBody({ fields: many }, LEAD_FIELD_PICK));
    assert.match(String(json.error), /at most 100/);
  });

  it("answers the door's own shapes", () => {
    assert.equal(pick(""), null, "no fields, no projection");
    assert.deepEqual(pick("?fields=email,score"), ["email", "score"]);
    assert.deepEqual(pick("?fields=email,email"), ["email"]);
    assert.deepEqual(pick("?fields=%20email%20"), ["email"]);
    for (const query of ["?fields=nonsense", "?fields=", "?fields=email,,score"]) {
      assert.ok(pick(query) instanceof Response, `${query} is refused with a Response, not a list`);
    }
  });
});

describe("leadSelect: exactly the columns named, and nothing else", () => {
  it("turns the names into a select of true", () => {
    assert.deepEqual(leadSelect(["email", "score"]), { email: true, score: true });
  });

  it("does not add id, and does not remove what was asked", () => {
    assert.deepEqual(Object.keys(leadSelect(["email"])), ["email"], "a caller who did not ask for the id is not given it");
  });

  it("renders every vocabulary word when all of them are asked", () => {
    const select = leadSelect(LEAD_EXPORT_FIELDS) as Record<string, unknown>;
    assert.deepEqual(Object.keys(select).sort(), [...LEAD_EXPORT_FIELDS].sort());
    assert.ok(Object.values(select).every((value) => value === true));
  });

  it("is built with fromEntries, so a name lands in its own key and nowhere else", () => {
    const select = leadSelect(["email"]) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(select, "toString"), false);
    const odd = leadSelect(["__proto__" as never]) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(odd, "__proto__"), true, "an own key, not a prototype rewrite");
    assert.equal(odd.__proto__, true, "and the value the name was given, not a silently dropped assignment");
  });
});

describe("the door applies the projection to the read, not to the answer", () => {
  const source = at("../../src/app/api/lead-lists/[id]/route.ts");
  const code = blankComments(resolveDelegation(source, functionBody(source, "GET_impl") ?? "", []));

  it("finds the handler, so the assertions below are about code", () => {
    assert.ok(code.length > 100, "a scanned body of " + code.length + " characters is a missing handler");
    assert.match(code, /prisma\.leadList\.findUnique/);
  });

  it("reads its query string", () => {
    assert.match(code, /new URL\(request\.url\)/);
    assert.match(code, /fieldsParam\(searchParams\)/);
  });

  it("judges the names against the declared table", () => {
    assert.match(code, /validateBody\(\s*\{\s*fields:\s*asked\s*\},\s*LEAD_FIELD_PICK\s*\)/);
  });

  it("puts the projection into the include, so the row is never fetched to be thinned", () => {
    assert.match(
      code,
      /lead:\s*picked\s*\?\s*\{\s*select:\s*leadSelect\(picked\)\s*\}\s*:\s*true/,
      "the select is decided on the way to the database",
    );
    assert.doesNotMatch(code, /JSON\.parse\(JSON\.stringify/, "no projection by serialization");
    assert.doesNotMatch(code, /delete\s+\w*\.?\s*lead\./, "no projection by deleting keys off a fetched row");
  });

  it("says which columns it handed back, and only when the caller asked", () => {
    assert.match(code, /picked\s*\?\s*\{\s*\.\.\.list,\s*memberFields:\s*picked\s*\}\s*:\s*list/);
  });

  it("keeps the not-found and the ownership check on the row it read", () => {
    assert.match(code, /if \(!list\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
    assert.match(code, /await assertOwns\(request, list\.workspaceId\)/);
    assert.ok(code.indexOf("assertOwns") > code.indexOf("findUnique"), "the read still answers 404 and 401 itself");
  });

  it("does not let a projection widen the member cap", () => {
    assert.match(code, /pageParams\(searchParams, 100\)/, "the cap is the door's own, and still defaults at 100");
    assert.match(code, /take:\s*limit/, "the read takes that cap rather than a number the projection could disagree with");
    assert.equal(/take:\s*\d+/.test(code), false, "no literal page size survives beside a paging parameter");
  });
});

describe("the module stays a query-string module", () => {
  const source = at("../../src/lib/list-fields.ts");
  const code = blankComments(source);

  it("imports nothing at runtime, so it is testable and every route can use it", () => {
    assert.match(code, /^import type \{[^}]*\} from "\.\/fields";$/m, "a type-only import of the vocabulary");
    assert.doesNotMatch(code, /^import\s+(?!type)/m, "no value import");
    for (const forbidden of ["next/", "@/lib/db", "node:fs", "node:http"]) {
      assert.ok(!code.includes(forbidden), `${forbidden} does not belong in a query-string reader`);
    }
  });

  it("quotes the measurement it exists to fix, before and after", () => {
    assert.match(source, /171720 bytes/);
    assert.match(source, /\?fields=nonsense/);
    assert.match(source, /20673/, "the after number sits in the same comment as the before number");
  });
});
