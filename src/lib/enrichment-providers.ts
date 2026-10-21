/**
 * The provider names this product can be told about, and the refusal when it is
 * told one it cannot use.
 *
 * `schema.prisma` spells `EnrichmentRule.providers Json // Which enrichment
 * providers to use`, and `RULE_CREATE` requires a non-empty array of strings.
 * Every name in that array is handed to `enrichWithProvider` in
 * `src/lib/enrichment.ts`, which dispatches on a `switch` and answers `null` for
 * anything it does not recognise. So a rule listing `"hubspot"` was created,
 * stored, read by the worker, and silently enriched nothing — while the operator
 * who typed it watched a workspace fill with leads that never got any of the
 * fields they asked for. `Apollo` (capital A) was the same story: the switch
 * compares exactly, so a name typed the way a sales page spells it matches no case.
 *
 * The list lives here rather than in `enums.ts` because it is not transcribed
 * from a schema comment — `enums.ts` takes only those. These are the names the
 * worker's own `switch` dispatches on, and `tests/unit/enrich-write.test.ts`
 * asserts that every name here has a case there, which is what keeps the two from
 * drifting apart.
 *
 * What each name is worth today is stated where the names are used, and repeated
 * here because a buyer will ask: `derive` works with no credentials — it reads the
 * seniority a person's own title states (`src/lib/seniority.ts`). The rest are the
 * call sites a key belongs in: they are wired, they are dispatched, and they
 * return nothing until they are configured. A placeholder that returns invented
 * company data is worse than one that returns nothing, because the invented data
 * lands in a customer's row and reads like research.
 */

/** Every name `enrichWithProvider` has a case for, in the spelling it compares. */
export const ENRICHMENT_PROVIDERS = [
  "derive",
  "apollo",
  "clearbit",
  "hunter",
  "linkedin",
  "clearbit_company",
  "apollo_company",
] as const;

export type EnrichmentProvider = (typeof ENRICHMENT_PROVIDERS)[number];

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Why this provider list cannot be used, naming every problem in one pass, or
 * `null` when it can. The shape (`a non-empty array of strings`) is
 * `RULE_CREATE`'s `kind: "strings"` business and is checked before this runs, so
 * every entry here is already a word; what is left is meaning — a name nothing
 * will ever call.
 */
export function providersProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return `providers must be a list of provider names (${ENRICHMENT_PROVIDERS.join(", ")}) — it is ${describe(value)}`;
  const unknown = value.filter((item) => normalizeName(item) === null);
  if (unknown.length === 0) return null;
  const named = unknown.map((item) => describe(item)).join(", ");
  return `${named} ${unknown.length > 1 ? "are" : "is"} not a provider this product calls — the names the worker dispatches on are ${ENRICHMENT_PROVIDERS.join(", ")}`;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const one = value.trim().toLowerCase();
  if (one === "") return null;
  return ENRICHMENT_PROVIDERS.includes(one as EnrichmentProvider) ? one : null;
}

/**
 * The spelling the worker compares: trimmed, lower-cased, de-duplicated, order
 * kept. `Apollo` and `apollo ` both mean the same call site, and a name that means
 * nothing is refused at the door rather than folded into silence here — this
 * function is the backstop for a caller that reaches for the shape without the
 * verdict, so it drops what no `switch` case can ever answer.
 */
export function normalizeProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const one = normalizeName(item);
    if (one !== null && !out.includes(one)) out.push(one);
  }
  return out;
}
