/**
 * The one enrichment LeadWorks can do without an API key: read the seniority a
 * person's own title states.
 *
 * `schema.prisma` spells `seniority String? // IC | MANAGER | DIRECTOR | VP |
 * C_LEVEL | UNKNOWN`, and the column is worth something in two places: the list a
 * buyer sorts and filters, and `EnrichmentRule.conditions`, where `seniority` is
 * one of the four attributes a rule can speak about. A lead imported from the
 * buyer's own CSV usually has a `title` and no `seniority` — the importer takes
 * what the file has — so the row carries the answer in prose and nothing reads it.
 *
 * Three rules this function keeps:
 *
 * - **It fills a gap; it never argues with a person.** The worker writes the value
 *   only where the column is empty, so a `seniority` someone set by hand survives.
 *   A title that reads as a different rung than the entry a rep typed is evidence
 *   about the title, not about the person.
 * - **It abstains.** A title outside the table returns `null`, which means "the
 *   title says nothing I will stand behind" — not `UNKNOWN`. That word is a
 *   judgment someone makes about a person, and a lookup that filed it as a default
 *   would record an opinion as a fact. So `Head of Growth`, `Team Lead`,
 *   `Principal` and `Architect` are absent on purpose: they mean different rungs at
 *   different companies.
 * - **The most specific reading wins, and the order of the checks is the whole
 *   disambiguation.** `Vice President` contains `President`, `Managing Director`
 *   contains `Director`, `General Manager` contains `Manager` — each of those words
 *   would answer a different rung than the title does, so the phrases are matched
 *   before the single-word scan. Where a title straddles two rungs without saying
 *   which it means, the table has no entry for it: `EVP`, `Head of Growth`,
 *   `Team Lead`, `Principal`, `Architect`.
 *
 * Every rung is typed as one of `enums.ts`' words, so the table cannot name a
 * value the column does not hold.
 */

import { LEAD_SENIORITIES } from "./enums";

type Rung = (typeof LEAD_SENIORITIES)[number];

/**
 * Multi-word titles whose rung is not what a word scan would answer: `Managing
 * Director` and `General Manager`, which contain `Director` and `Manager` at a
 * lower rung, and `Vice President`, which contains `President`.
 */
const PHRASES: [RegExp, Rung][] = [
  [/chief executive/, "C_LEVEL"],
  [/\bchief [a-z]+ officer\b/, "C_LEVEL"],
  [/managing director/, "C_LEVEL"],
  [/vice president/, "VP"],
  [/\bvp\b/, "VP"],
  [/general manager/, "DIRECTOR"],
  [/head of (sales|marketing|engineering)/, "DIRECTOR"],
];

/** Single words, consulted only after the phrases above have not matched. */
const WORDS: Record<string, Rung> = {
  ceo: "C_LEVEL",
  cto: "C_LEVEL",
  cfo: "C_LEVEL",
  coo: "C_LEVEL",
  cio: "C_LEVEL",
  cmo: "C_LEVEL",
  founder: "C_LEVEL",
  cofounder: "C_LEVEL",
  owner: "C_LEVEL",
  president: "C_LEVEL",
  partner: "C_LEVEL",
  chair: "C_LEVEL",
  chairman: "C_LEVEL",
  director: "DIRECTOR",
  manager: "MANAGER",
  supervisor: "MANAGER",
  intern: "IC",
  associate: "IC",
  analyst: "IC",
  consultant: "IC",
  coordinator: "IC",
  representative: "IC",
  agent: "IC",
  specialist: "IC",
  assistant: "IC",
  executive: "IC",
  engineer: "IC",
  developer: "IC",
  designer: "IC",
};

/** The rung a title states, or `null` when it states none. */
export function seniorityFromTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const text = title.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") return null;

  for (const [pattern, rung] of PHRASES) {
    if (pattern.test(text)) return rung;
  }

  for (const word of text.split(/[^a-z]+/).filter((w) => w !== "")) {
    const rung = WORDS[word];
    if (rung !== undefined) return rung;
  }

  return null;
}

/** Every rung the table can name — the test's cross-check against the schema's list. */
export function seniorityTableRungs(): Rung[] {
  const named = new Set<Rung>();
  for (const [, rung] of PHRASES) named.add(rung);
  for (const rung of Object.values(WORDS)) named.add(rung);
  return [...named].sort();
}
