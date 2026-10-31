// #65: one address, one row. The two doors that take an email from a caller asked
// `@@unique([workspaceId, email])` — which compares bytes — and nothing about case, so a
// workspace that held `john@x.com` accepted the same person again in another spelling.
// Measured on this round's base build (`e3fcc16`) in its own runtime — `:3417` over
// `leadworks_r66`, two workspaces and two keys, the DEDUPE worker allowed to reach its own
// verdict; logs `/tmp/opencode/r66_press_base.log` and `/tmp/opencode/r66_extras_base.log`,
// row truth from `psql … "Lead"`:
//
//   POST /api/leads {email:"john@x.com"}         201  cmvqf4fjs000b…
//   POST /api/leads {email:"john@x.com"} again   409  "That Lead already exists in this workspace."
//   POST /api/leads {email:"JOHN@X.COM"}         201  cmvqf4fl3000d…   ← a second person
//   POST /api/leads {email:"John@X.com"}         201  cmvqf4flw000e…   ← a third
//   POST /api/leads {email:"  JOHN@X.COM  "}     409  (text is trimmed, then the index answers)
//   POST /api/leads {email:"JOHN@X.COM"} as B    201  (the index is per workspace, and stays so)
//   POST /api/leads/import  JoHn@X.com           200  imported=0 duplicatesExisting=1
//   POST /api/leads/import  Nina@Y.com           201  imported=1 — stored lower-cased
//   GET  /api/leads?limit=100                    200  total=5: john@x.com | John@X.com | JOHN@X.COM
//   POST /api/jobs {DEDUPE, strategy:email, action:merge}
//                                                COMPLETED found=2 resolved=2 — five rows became four
//   PATCH /api/leads/<nina> {email:"JoHn@X.cOm"} 200  — the update door made a fourth spelling
//
// Three of those legs are the product's own opinion, already stated elsewhere: `csv-import.ts`
// looks for the address with `mode: "insensitive"` before it inserts, `dedupe.ts:216` calls the
// two rows duplicates by definition (`a.email.toLowerCase() === b.email.toLowerCase()`) and
// spends a merge folding them, and `auth-actions.ts` lower-cases an address before it looks for
// an account. The only place left where a person could be written twice was the door that takes
// one address at a time — and what those doors wrote anyway, the DEDUPE job undid at two merges.
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conflictFor } from "../../src/lib/apikeys";
import { openapiOperations } from "../../src/lib/openapi";
import { emailCaseConflict, emailCaseHolder } from "../../src/lib/lead-email";
import { blankComments, functionBody } from "./route-handlers";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** A file named from the repository root, read as this suite's own file is read. */
const fromRoot = (relativePath: string) => at(`../../${relativePath}`);
const create = blankComments(functionBody(fromRoot("src/app/api/leads/route.ts"), "POST_impl")!);
const edit = blankComments(functionBody(fromRoot("src/app/api/leads/[id]/route.ts"), "PATCH_impl")!);

const ROW = { id: "cmrealtsofd", email: "john@x.com" };

/** The refusal as its caller reads it. */
async function refusal(asked: string, holder = ROW) {
  const response = emailCaseConflict(holder, asked);
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

/** The P2002 shape `conflict.test.ts` already builds: name + code + meta, no generated class. */
function prismaError(code: string, meta?: unknown): Error {
  const error = new Error("Unique constraint failed") as Error & { code: string; meta?: unknown };
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  if (meta !== undefined) error.meta = meta;
  return error;
}

/** Every `.ts` under `src`, as root-relative paths, sorted. */
function sourceTree(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  return [...walk("src")].sort();
}

describe("emailCaseHolder: which rows make a re-spelled address the same person", () => {
  it("finds no collision when the workspace holds nothing that folds alike", () => {
    assert.equal(emailCaseHolder("john@x.com", []), null);
    assert.equal(emailCaseHolder("john@x.com", [{ id: "r1", email: "someone@x.com" }]), null);
    assert.equal(emailCaseHolder("john@x.com", [{ id: "r1", email: "john@x.co" }]), null);
    assert.equal(emailCaseHolder("john@x.com", [{ id: "r1", email: "xjohn@x.com" }]), null);
  });

  it("stands down when a row already holds the very bytes, even beside a case variant", () => {
    // The unique index answers that request as a 409 and `conflict.test.ts` pins its sentence;
    // this file's would only displace it. Order is what makes this a rule rather than an
    // accident: the exact holder listed *after* the variant still stands down.
    const rows = [
      { id: "cmvariant", email: "John@X.com" },
      { id: "cmexact", email: "john@x.com" },
    ];
    assert.equal(emailCaseHolder("john@x.com", rows), null);
    assert.equal(emailCaseHolder("john@x.com", rows.slice().reverse()), null);
  });

  it("names the first holder whose address folds to the same one, in either direction", () => {
    assert.deepEqual(emailCaseHolder("JOHN@X.COM", [ROW]), ROW);
    assert.deepEqual(emailCaseHolder("john@x.com", [{ id: "cmupper", email: "JOHN@X.COM" }]), {
      id: "cmupper",
      email: "JOHN@X.COM",
    });
    assert.deepEqual(emailCaseHolder("Jo.Hn@X.cOm", [{ id: "r1", email: "jo.hn@x.com" }]), {
      id: "r1",
      email: "jo.hn@x.com",
    });
  });

  it("names the earliest of several spellings, because that is the row the press collided with", () => {
    // Both doors ask Postgres for `orderBy: { createdAt: "asc" }`, so `holders` arrives in
    // that order and the same press gets the same refusal twice. Pinned on the doors below.
    const holders = [
      { id: "oldest", email: "John@X.com" },
      { id: "newer", email: "JOHN@X.COM" },
    ];
    assert.deepEqual(emailCaseHolder("john@x.com", holders), holders[0]);
    assert.deepEqual(emailCaseHolder("john@x.com", holders.slice().reverse()), holders[1]);
  });

  it("does not treat a row with no address as a holder of any address", () => {
    // `Lead.email` is nullable and a lead with only a phone is a person you met, so a null
    // email can be in any workspace's rows — it must not become a collision with anything,
    // and it must not stand between a variant and the row that actually holds the address.
    assert.equal(emailCaseHolder("john@x.com", [{ id: "phoneonly", email: null }]), null);
    assert.equal(emailCaseHolder("JOHN@X.COM", [{ id: "phoneonly", email: null }]), null);
    assert.deepEqual(emailCaseHolder("JOHN@X.COM", [{ id: "phoneonly", email: null }, ROW]), ROW);
  });

  it("folds case and nothing else: accents, spacing and scripts are not case", () => {
    // Stated as a limit. `dedupe.ts`'s email rule is the same two `toLowerCase()` calls, so a
    // homoglyph address is a different address at both doors and at the merge.
    assert.equal(emailCaseHolder("john@x.cöm", [{ id: "r1", email: "john@x.com" }]), null);
    assert.equal(emailCaseHolder("john@x.com", [{ id: "r1", email: "john @x.com" }]), null);
    assert.equal(emailCaseHolder("admin@x.com", [{ id: "r1", email: "аdmin@x.com" }]), null);
  });

  it("judges the whole address, so the domain's case collides the same as the local part's", () => {
    assert.deepEqual(emailCaseHolder("john@X.COM", [ROW]), ROW);
    assert.deepEqual(emailCaseHolder("JOHN@x.com", [ROW]), ROW);
  });
});

describe("the case refusal is the index's own shape, plus the row it names", () => {
  it("is a 409 — the status the same collision already gets byte for byte", async () => {
    assert.equal((await refusal("JOHN@X.COM")).status, 409);
  });

  it("opens with the sentence `conflictFor` builds for this column, so the two agree", async () => {
    const { json } = await refusal("JOHN@X.COM");
    const fromIndex = conflictFor(prismaError("P2002", { modelName: "Lead", target: ["workspaceId", "email"] }));
    assert.equal(fromIndex?.body.error, "A Lead with this email already exists in this workspace.");
    // Same clause, then the id: a caller who reads one has already read the other.
    assert.equal(json.error.startsWith(fromIndex!.body.error.slice(0, -1)), true, json.error);
  });

  it("names the row it collided with and both spellings, as the caller sent them", async () => {
    const { json } = await refusal("JOHN@X.COM", { id: "cmrealtsofd", email: "John@x.com" });
    const error = json.error as string;
    assert.match(error, /already exists in this workspace as cmrealtsofd/);
    assert.ok(error.includes('"JOHN@X.COM"'), error);
    assert.ok(error.includes('"John@x.com"'), error);
    assert.deepEqual(json.conflict, {
      fields: ["email"],
      existingId: "cmrealtsofd",
      existingEmail: "John@x.com",
      askedEmail: "JOHN@X.COM",
    });
  });

  it("says nothing about the row beyond its id and its address", async () => {
    // The refusal is built from `{ id, email }` and both doors select nothing else, so a
    // column the caller was not entitled to cannot arrive through an error message.
    const { json } = await refusal("JOHN@X.COM");
    assert.deepEqual(Object.keys(json).sort(), ["conflict", "error"]);
    assert.deepEqual(Object.keys(json.conflict).sort(), ["askedEmail", "existingEmail", "existingId", "fields"]);
  });

  it("agrees with the index's 409 on `fields`, and carries the row that 409 cannot name", () => {
    // Measured on this round's database (`scripts/r66-meta-probe`, run then deleted): the
    // driver adapter Prisma 7 requires puts the violation in `meta.driverAdapterError.cause`
    // with a constraint name and no `meta.target` at all.
    //
    // RETARGETED on rebase onto `88bf6d2` (#100): this pin asserted the gap it was written
    // against — `conflict: { fields: [] }` and "That Lead already exists in this workspace."
    // `src/lib/unique-index.ts` now reads the columns out of the constraint's own name, so the
    // byte-identical duplicate answers `fields: ["email"]` with the same clause this round's
    // refusal opens with. What the index still cannot do is name the *row* — an index violation
    // carries columns, not an id — so that, not `fields`, is what this round adds. Pinned in
    // both directions: the two bodies agree on `fields`, and only this round's carries the id.
    const measured = conflictFor(prismaError("P2002", {
      modelName: "Lead",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { index: "Lead_workspaceId_email_key" },
          table: "Lead",
        },
      },
    }));
    assert.deepEqual(measured?.body.conflict, { fields: ["email"] });
    assert.equal(measured?.body.error, "A Lead with this email already exists in this workspace.");
    // The id the index's answer cannot carry is exactly the key this round's does.
    assert.deepEqual(Object.keys(measured!.body.conflict).sort(), ["fields"]);
  });

  it("still refuses when a name does not decompose, and this round does not lean on that path", async () => {
    // #100's own limit: a constraint that is not `<table>_<columns>_key` keeps the nameless
    // body. This round's refusal is built from the rows the lookup handed back, so it names
    // `fields: ["email"]` and the holder whichever way the index's sentence falls out — the
    // two are not wired together, which is why a later change to `unique-index.ts` cannot
    // silently empty this refusal's `conflict`.
    const nameless = conflictFor(prismaError("P2002", {
      modelName: "Lead",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          kind: "UniqueConstraintViolation",
          constraint: { index: "lead_email_dupes" },
          table: "Lead",
        },
      },
    }));
    assert.deepEqual(nameless?.body.conflict, { fields: [] });
    const { json } = await refusal("JOHN@X.COM");
    assert.deepEqual(json.conflict.fields, ["email"]);
    assert.equal(json.conflict.existingId, "cmrealtsofd");
  });
});

describe("the two doors that take an address ask the fold before they write", () => {
  /** The exact shape of a case-folded lookup: scoped, two columns, oldest first. */
  const lookup = (where: string) =>
    new RegExp(
      `prisma\\.lead\\.findMany\\(\\s*\\{\\s*where: \\{\\s*${where},?\\s*\\},?\\s*` +
        `select: \\{\\s*id: true, email: true,?\\s*\\},?\\s*` +
        `orderBy: \\{\\s*createdAt: "asc",?\\s*\\},?\\s*\\}\\s*\\)`,
    );

  it("POST /api/leads looks for the folded holder, scoped to the caller's workspace", () => {
    // Retargeted by #77, with the reason: the fold moved from this door's inline object into
    // `lead-email.ts`'s `emailFold()`, so the door now names the rule instead of spelling it.
    // Everything else in the shape — the scope, the two columns, oldest first — is unchanged.
    assert.match(create, lookup(`workspaceId, email: emailFold\\(askedEmail\\)`));
    assert.match(create, /if \(typeof askedEmail === "string"\)/);
    assert.match(create, /const holder = emailCaseHolder\(askedEmail, holders\);/);
    assert.match(create, /if \(holder\) return emailCaseConflict\(holder, askedEmail\);/);
  });

  it("POST /api/leads refuses before the row exists, and after the table has judged the body", () => {
    const asked = create.indexOf("const askedEmail = input.data.email;");
    assert.ok(asked > 0, "the create door never asks about the address");
    assert.ok(create.indexOf("validateBody(body, LEAD_CREATE)") < asked, "it asks before validating the body");
    assert.ok(create.indexOf('"at least one contact method required"') < asked, "it asks before the contact-method 400");
    assert.ok(asked < create.indexOf("prisma.lead.create("), "the refusal is raised after the insert");
  });

  it("POST /api/leads writes the address it was given, not a folded one", () => {
    // Refusing a second row is this round's promise; rewriting the bytes of the first is not.
    // A brand-new address is still stored verbatim, which is why the README can say the two
    // doors and the importer differ about stored spelling while agreeing about who is a duplicate.
    assert.doesNotMatch(create, /askedEmail\.toLowerCase\(\)/);
    assert.doesNotMatch(create, /normalizeEmail/);
    assert.match(create, /data: \{\s*workspaceId,\s*\.\.\.input\.data,/);
  });

  it("PATCH /api/leads/{id} asks the same question of the other rows only", () => {
    // Retargeted by #77 with the POST lookup above: one helper, two doors.
    assert.match(
      edit,
      lookup(`workspaceId: before\\.workspaceId,\\s*id: \\{ not: id \\},\\s*email: emailFold\\(askedEmail\\)`),
    );
    assert.match(edit, /if \(typeof askedEmail === "string"\)/);
    assert.ok(
      edit.indexOf("const askedEmail = fields.email;") < edit.indexOf("prisma.lead.update("),
      "the refusal is raised after the update",
    );
  });

  it("PATCH /api/leads/{id} keeps a row's own address an edit, not a collision", () => {
    // The exclusion sits in the lookup rather than in the helper, so the helper never needs to
    // know which door called it and `exceptId` is not a parameter passed by one caller and
    // forgotten by the other.
    assert.match(edit, /id: \{ not: id \}/);
    assert.doesNotMatch(fromRoot("src/lib/lead-email.ts"), /exceptId/);
    assert.match(edit, /data: \{\s*\.\.\.fields,\s*scoreOverride,/);
  });

  it("no third door reaches for this module", () => {
    // Retargeted by #77, with the reason: `csv-import.ts` already folded case with an inline
    // `{ in, mode: "insensitive" }`; the refactor moved that spelling into `emailFoldIn()` here, so
    // the importer now imports the rule (relatively, as a sibling lib file) instead of re-typing it.
    // The list is not widened to "anyone" — it is still exactly the doors that take an address.
    const importers = sourceTree().filter(
      (file) => file !== "src/lib/lead-email.ts" && /from "(?:@\/lib\/|\.\/)lead-email"/.test(fromRoot(file)),
    );
    assert.deepEqual(importers, [
      "src/app/api/leads/[id]/route.ts",
      "src/app/api/leads/route.ts",
      "src/lib/csv-import.ts",
    ]);
  });
});

describe("the contract says one address is one row, at both doors", () => {
  const responsesFor = (operationId: string): Record<string, string> => {
    const entry = openapiOperations.find((found) => found.operation.id === operationId);
    assert.ok(entry, `the contract has no ${operationId}`);
    assert.ok(entry!.operation.responses, `${operationId} documents no responses`);
    return entry!.operation.responses as Record<string, string>;
  };

  const propertyFor = (operationId: string, name: string): string => {
    const entry = openapiOperations.find((found) => found.operation.id === operationId);
    const properties = (entry!.operation.body as { properties: Record<string, { description: string }> }).properties;
    assert.ok(properties?.[name], `${operationId} has no ${name}`);
    return properties[name].description;
  };

  it("POST /api/leads prices a duplicate at 409 and a bad list id at 422", () => {
    const responses = responsesFor("leads.create");
    assert.match(responses["409"], /One address is one row/);
    assert.match(responses["409"], /in another case, refused by name with the id/);
    assert.match(responses["422"], /listIds/);
    assert.match(responses["400"], /not an address/);
    // The sentence this round replaced claimed a duplicate was a 422, and the measured base
    // answer for one was a 409.
    assert.doesNotMatch(responses["201"], /422|duplicate/);
  });

  it("PATCH /api/leads/{id} says the same, and prices the other three refusals it gives", () => {
    const responses = responsesFor("leads.update");
    assert.match(responses["409"], /in another case, refused by name with the id/);
    assert.match(responses["404"], /No lead of this workspace/);
    assert.match(responses["400"], /changes nothing/);
    assert.match(responses["200"], /as it now reads/);
  });

  it("describes the `email` field by the promise, at both doors", () => {
    assert.match(propertyFor("leads.create", "email"), /One address is one row per workspace/);
    assert.match(propertyFor("leads.update", "email"), /does not already hold, in this case or another/);
  });

  it("leaves the importer's older promise standing, because this round leans on it", () => {
    // `duplicatesExisting` is the fold's existing report: the documented belief the two
    // single-lead doors had not caught up with.
    assert.match(fromRoot("README.md"), /already in the workspace, matched case-insensitively by\s+email/);
    assert.match(fromRoot("src/lib/openapi.ts"), /the same door one lead takes/);
  });
});

describe("the census: who decides whether an address is new", () => {
  it("names every place in the app that writes a Lead row", () => {
    const writers = sourceTree().filter((file) =>
      /prisma\.lead\.(create|createMany|createManyAndReturn|update|updateMany|upsert)\s*\(/.test(blankComments(fromRoot(file))),
    );
    assert.deepEqual(writers, [
      "src/app/api/leads/[id]/route.ts",
      "src/app/api/leads/route.ts",
      "src/lib/csv-import.ts",
      "src/lib/dedupe.ts",
      "src/lib/enrichment.ts",
      "src/lib/scraper.ts",
      "src/lib/validator.ts",
    ]);
  });

  it("writes the fold once, and every door that takes an address asks for it", () => {
    // Retargeted by #77, with the reason. This census used to expect `mode: "insensitive"` inline in
    // each of the three doors, which was true while three doors each spelled the rule. #77 folded
    // the read door too, and four spellings of one rule is exactly how they drift, so the claim now
    // has one home — `lead-email.ts` — and the census asks that every address-taking door calls it.
    const folders = sourceTree().filter((file) => /mode: "insensitive"/.test(blankComments(fromRoot(file))));
    assert.deepEqual(folders, ["src/lib/lead-email.ts"], "the fold is written once, and nowhere else");
    for (const door of [
      "src/app/api/leads/[id]/route.ts",
      "src/app/api/leads/route.ts",
      "src/lib/csv-import.ts",
    ]) {
      assert.match(blankComments(fromRoot(door)), /\bemailFold(In)?\(/, `${door} asks the shared fold`);
    }
    // The read door's own caller: the comparison this round was opened for.
    assert.match(blankComments(fromRoot("src/app/api/leads/route.ts")), /emailFold\(email\.value\)/);
  });

  it("keeps the importer the only place that also rewrites the bytes it stores", () => {
    // Measured: `Nina@Y.com` arrives as `Nina@Y.com` and is held as `nina@y.com`, because the
    // file door lower-cases a column the caller never typed. The two single-lead doors refuse
    // a collision instead, and store a new address exactly as it was sent.
    assert.match(fromRoot("src/lib/csv-parse.ts"), /function normalizeEmail[\s\S]*?toLowerCase\(\)/);
    assert.doesNotMatch(create, /toLowerCase/);
    assert.doesNotMatch(edit, /toLowerCase/);
  });

  it("leaves the scrape's own byte-exact lookup standing, and says so", () => {
    // Not an HTTP door: `scraper.ts` matches a source's row with
    // `findUnique({ where: { workspaceId_email: … } })`, which is as case-blind as the index
    // this round stopped trusting — so a scrape of `JOHN@X.COM` against a workspace holding
    // `john@x.com` still creates a second row. Its input is a provider's field rather than a
    // caller's typo, the fold there is the same one line, and this round's README names it.
    const scrape = blankComments(fromRoot("src/lib/scraper.ts"));
    assert.match(scrape, /where: \{ workspaceId_email: \{ workspaceId, email: lead\.email \} \}/);
    assert.doesNotMatch(scrape, /insensitive/);
  });
});
