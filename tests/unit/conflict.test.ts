// A duplicate POST used to answer 500, which is the one status a correct client
// retries. These tests pin the opposite: a known collision is a 409 that names
// what collided, and everything that is not a collision still propagates.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conflictFor } from "../../src/lib/apikeys";

/**
 * Built structurally, the way Prisma's error is read: name + code + meta. No
 * generated class, no database — the mapper only relies on those three.
 */
function prismaError(code: string, meta?: unknown): Error {
  const error = new Error("Unique constraint failed on the fields: (`email`)") as Error & {
    code: string;
    meta?: unknown;
  };
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  if (meta !== undefined) error.meta = meta;
  return error;
}

describe("unique violations answer with a status, not a crash", () => {
  it("maps P2002 to 409 and names the column that collided", () => {
    const result = conflictFor(prismaError("P2002", { modelName: "Lead", target: ["email"] }));
    assert.equal(result?.status, 409);
    assert.deepEqual(result?.body.conflict, { fields: ["email"] });
    assert.equal(result?.body.error, "A Lead with this email already exists in this workspace.");
  });

  it("names a composite collision without repeating the workspace it is scoped to", () => {
    const result = conflictFor(prismaError("P2002", { modelName: "Agent", target: ["workspaceId", "name"] }));
    assert.deepEqual(result?.body.conflict, { fields: ["name"] });
    assert.match(String(result?.body.error), /this name/);
    assert.doesNotMatch(String(result?.body.error), /workspaceId/);
  });

  it("joins two real columns rather than dropping one", () => {
    const result = conflictFor(prismaError("P2002", { modelName: "Membership", target: ["userId", "plan"] }));
    assert.deepEqual(result?.body.conflict, { fields: ["userId", "plan"] });
    assert.match(String(result?.body.error), /userId \+ plan/);
  });

  it("accepts the bare-string target as well as the array", () => {
    const result = conflictFor(prismaError("P2002", { modelName: "Metric", target: "name" }));
    assert.deepEqual(result?.body.conflict, { fields: ["name"] });
  });

  it("still returns a conflict when the metadata is missing", () => {
    const result = conflictFor(prismaError("P2002"));
    assert.equal(result?.status, 409);
    assert.match(String(result?.body.error), /already exists in this workspace/);
  });

  it("leaves every other failure to the caller", () => {
    assert.equal(conflictFor(prismaError("P2025", { modelName: "Lead", target: ["id"] })), null);
    assert.equal(conflictFor(new Error("Unique constraint failed")), null);
    assert.equal(conflictFor({ code: "P2002", name: "PrismaClientKnownRequestError" }), null);
    assert.equal(conflictFor(null), null);
    assert.equal(conflictFor("P2002"), null);
  });
});
