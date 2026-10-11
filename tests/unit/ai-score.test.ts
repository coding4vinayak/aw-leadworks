// Guard-rail tests for AI lead-score explanations. No network, no key, no DB.
// The property under test: without a model there is no explanation, and the
// deterministic score is never the model's to change.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { explainLeadScore } from "../../src/lib/ai-score";

beforeEach(() => {
  delete process.env.LLM_API_KEY;
});

describe("explainLeadScore offline contract", () => {
  it("returns null when no model is configured", async () => {
    const explanation = await explainLeadScore({
      score: 65,
      lead: { firstName: "Ada", company: "Acme", title: "VP Sales", email: "ada@acme.test" },
      enrichment: { email: "ada@acme.test", title: "VP Sales" },
      source: "manual",
    });
    assert.equal(explanation, null, "an absent explanation is not a defect; a wrong one would be");
  });

  it("returns null for a lead with no enrichment rather than inventing reasons", async () => {
    // Same call shape the route uses for thin leads. The model is absent, so
    // this asserts the degradation path both callers share.
    const explanation = await explainLeadScore({
      score: 20,
      lead: { email: "anon@example.test" },
      enrichment: {},
      source: "csv-import",
    });
    assert.equal(explanation, null);
  });
});
