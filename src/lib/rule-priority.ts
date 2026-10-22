/**
 * #34 — `EnrichmentRule.priority` is a ranking, and a ranking decides something.
 *
 * The column has always been stored (`Int @default(0)`), always been accepted by both
 * rule doors, and always been returned to whoever asked. Nothing ever ordered by it: the
 * list door sorts `orderBy: { createdAt: "desc" }`, and both sweep copies asked
 * `findMany({ where: { isActive: true, trigger: "SCHEDULED" } })` with **no `orderBy` at
 * all**, so the order the rules were applied in was the order the storage engine happened
 * to hand back rows. Measured against the running app before this round — one lead, three
 * `SCHEDULED` rules over it, created in the order priority 10, 90, 50:
 *
 *   1. `GET /api/enrichment-rules` returned **50, 90, 10** — creation order reversed, the
 *      ranking in none of it;
 *   2. the sweep queued **10 at 07:27:00.096, 90 at .115, 50 at .124** — heap order;
 *   3. **the rule that filled the column was `50`, the one queued last**, because the
 *      `enrich` worker runs at `concurrency: 5` (`src/lib/queue.ts:276`): the three jobs
 *      raced, and whichever write landed first won the column, enrichment being additive;
 *   4. two sweep minutes later that one lead had been **visited six times and logged six
 *      times, every row recording `creditsUsed: 1`**, five of those visits guaranteed refusals.
 *
 * That third line is why this module exists rather than an `orderBy` alone: putting the
 * queue in ranking order would still hand the same lead to several rules at once and let a
 * race decide what they write. What a ranking *can* decide, and what this decides, is
 * **which rule owns a column this minute**: the rules that are due are walked
 * highest-ranked first, each claims the columns its own `actions.fields` asked for, and a
 * lower-ranked rule is left with what is remaining — so the operator's number, not the
 * storage engine's mood and not a worker's timing, says whose word lands.
 *
 * Ties are broken by `createdAt` then `id`, which makes the walk a **total order**: the
 * same two rules produce the same plan every minute, and a plan with no tie in it cannot
 * depend on which row `findMany` happened to return first. `RULE_PRIORITY_ORDER` is the
 * same three keys in SQL, so what the door lists and what the sweep does are one rule
 * spelled twice rather than two rules that drift. Its type is the generated client's own
 * order-by, so a column that stops being orderable stops the build instead of silently
 * ordering nothing.
 *
 * Limits this module will not pretend away:
 *
 * - **A rule that says nothing about columns claims them all.** `actions.fields` absent
 *   means "the rule did not say" (round #32's reading), and a rule that did not say wants
 *   whatever its provider answers, so it owns every writable column for this minute and a
 *   lower-ranked rule asking for one of those visits nobody. Ranking is exclusivity, and a
 *   broad rule outranks a narrow one by rank rather than by breadth — which is only
 *   surprising when the ranking is forgotten, which is what this round fixes.
 * - **A rule with nothing left queues nothing.** No job, no log row — so nothing recorded
 *   against `creditsUsed` either — and no `lastEnrichedAt` stamp, because no visit happened,
 *   and round #29's rule is that a timestamp nobody asked for is a lie. The skip itself goes
 *   to the server log.
 * - **`?action=run` is not ranked.** An explicit run names the rule and the operator outranks
 *   every number in the table; the narrowing there is still that rule's own `fields`.
 * - **Claiming is per workspace.** Two tenants' rules never compete for the same column, and
 *   the sweep — which walks every workspace's rules in one query — would otherwise let a
 *   crowded workspace starve a quiet one.
 * - The plan is decided **before any provider runs**: a rule claims what it *asked* for,
 *   not what a provider happened to answer, so the same rules produce the same plan whatever
 *   the providers do.
 */

import type { Prisma } from "@/generated/prisma/client";
import type { RuleConditions } from "./rule-conditions";
import { ENRICH_WRITABLE } from "./enrich-plan";
import { readRuleActions } from "./rule-actions";

/**
 * What the doors accept. An `Int` column will hold anything a client names, and a ranking
 * that spans nine orders of magnitude is not a ranking — the range is stated once here and
 * both doors quote it in their refusal.
 */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;

/** The schema's own default, which is what every rule stored before this column meant anything. */
export const PRIORITY_DEFAULT = 0;

/**
 * The ranking as SQL: highest rank first, and a tie broken by the row that has been waiting
 * longer, then by its id so the order is total. Every reader that lists rules uses this.
 */
export const RULE_PRIORITY_ORDER: Prisma.EnrichmentRuleOrderByWithRelationInput[] = [
  { priority: "desc" },
  { createdAt: "asc" },
  { id: "asc" },
];

/** The three keys `planTick` walks on. Prisma's `EnrichmentRule` row satisfies this. */
export interface RankedRule {
  id: string;
  workspaceId: string;
  createdAt: Date;
  priority: number;
}

/** A rule the tick plan can be asked about: a ranking, a tenant, and its own declaration. */
export interface ClaimableRule extends RankedRule {
  actions: unknown;
}

/**
 * What both sweeps build before ranking: a claimable rule plus the two things a job needs
 * that the ranking itself does not. Exported because the sweep in `scheduler.ts` and the
 * idle copy in `enrichment.ts` must walk the same shape, or they can decide different
 * owners for the same columns.
 */
export interface DueRule extends ClaimableRule {
  providers: string[];
  conditions: RuleConditions;
}

/**
 * The comparator behind `RULE_PRIORITY_ORDER`. Kept as a function because the sweep walks
 * the ranking in memory — it has to, since the claim set is built as it walks — and because
 * the tie-break is the part no single query can show.
 */
export function compareByPriority(a: RankedRule, b: RankedRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const born = a.createdAt.getTime() - b.createdAt.getTime();
  if (born !== 0) return born;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The rules in ranking order. A copy, because callers keep iterating their own array. */
export function rankRules<T extends RankedRule>(rules: readonly T[]): T[] {
  return [...rules].sort(compareByPriority);
}

/**
 * The columns this rule may still own, given what higher-ranked rules already claimed.
 * `null` is the rule saying nothing about columns — every writable one is its ask.
 */
export function unclaimedFields(asked: readonly string[] | null, claimed: ReadonlySet<string>): string[] {
  const wants = asked === null ? [...ENRICH_WRITABLE] : asked;
  return wants.filter((column) => !claimed.has(column));
}

/** One rule's visit for this minute: the rule, and the columns it owns while doing it. */
export interface TickVisit<T> {
  rule: T;
  /** The columns this rule may write, in its own declared order. Never empty. */
  fields: string[];
}

/** One rule that got nothing this minute, and what it wanted. */
export interface TickStarved<T> {
  rule: T;
  asked: string[] | null;
}

/** What one sweep minute decides. Both halves are printed, because both are the ranking. */
export interface TickPlan<T> {
  visits: TickVisit<T>[];
  starved: TickStarved<T>[];
}

/**
 * The tick plan: who visits what, in ranking order, for one sweep minute.
 *
 * Rules are walked per workspace (a tenant's rules compete with each other and with nobody
 * else), highest-ranked first; each claims the columns it asked for that no higher-ranked
 * rule has taken, and a rule left with nothing appears in `starved` rather than `visits`.
 * The input order is irrelevant — the walk ranks — which is what lets the caller hand back
 * whatever the engine felt like returning.
 */
export function planTick<T extends ClaimableRule>(rules: readonly T[]): TickPlan<T> {
  const byWorkspace = new Map<string, T[]>();
  for (const rule of rules) {
    const group = byWorkspace.get(rule.workspaceId);
    if (group) group.push(rule);
    else byWorkspace.set(rule.workspaceId, [rule]);
  }

  const visits: TickVisit<T>[] = [];
  const starved: TickStarved<T>[] = [];
  for (const group of byWorkspace.values()) {
    const claimed = new Set<string>();
    for (const rule of rankRules(group)) {
      const asked = readRuleActions(rule.actions).fields;
      const fields = unclaimedFields(asked, claimed);
      if (fields.length === 0) {
        starved.push({ rule, asked });
        continue;
      }
      for (const column of fields) claimed.add(column);
      visits.push({ rule, fields });
    }
  }
  return { visits, starved };
}
