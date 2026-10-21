import { prisma } from "./db";
import { rowAfterWrite, scoredWriteData } from "./lead-score";

export interface DedupeConfig {
  strategy: "email" | "phone" | "linkedin" | "company_name" | "fuzzy";
  threshold?: number;
  action?: "merge" | "delete" | "flag";
  keepOldest?: boolean;
}

export const DEDUPE_STRATEGIES = ["email", "phone", "linkedin", "company_name", "fuzzy"] as const;
export const DEDUPE_ACTIONS = ["merge", "delete", "flag"] as const;

/**
 * The config a job must carry to be runnable — read as the caller's words, not
 * as truthiness. Before this, an unrecognised strategy matched nothing:
 * `areDuplicates` fell through to `false`, the job counted zero groups,
 * reported COMPLETED and told the caller their list was clean. A dedupe run
 * that silently does nothing is worse than one that fails, because the caller
 * stops looking.
 */
export function readDedupeConfig(raw: unknown): DedupeConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config must be an object with a strategy");
  }
  const { strategy, action, threshold, keepOldest } = raw as Record<string, unknown>;
  if (typeof strategy !== "string" || !(DEDUPE_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new Error(`unknown strategy ${JSON.stringify(strategy)} — use one of ${DEDUPE_STRATEGIES.join(", ")}`);
  }
  if (action !== undefined && (typeof action !== "string" || !(DEDUPE_ACTIONS as readonly string[]).includes(action))) {
    throw new Error(`unknown action ${JSON.stringify(action)} — use one of ${DEDUPE_ACTIONS.join(", ")}`);
  }
  if (threshold !== undefined && typeof threshold !== "number") {
    throw new Error("threshold must be a number");
  }
  if (keepOldest !== undefined && typeof keepOldest !== "boolean") {
    throw new Error("keepOldest must be true or false");
  }
  return {
    strategy: strategy as DedupeConfig["strategy"],
    ...(action !== undefined ? { action: action as DedupeConfig["action"] } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(keepOldest !== undefined ? { keepOldest } : {}),
  };
}

/** The fields merge copies when the master is missing them. */
const MERGE_SCALARS = [
  "email", "phone", "linkedinUrl", "firstName", "lastName", "company", "title",
  "department", "seniority", "location", "country", "industry", "companySize", "revenue",
] as const;

/**
 * What a `merge` action writes onto the master. Pure so the rule is testable:
 * scalar fields fill blanks only (the master is the survivor, so it never
 * loses a value); array fields union; object fields merge with the master's
 * keys winning. Returns {} when the duplicate carries nothing new.
 */
export function planMerge(master: Record<string, any>, duplicate: Record<string, any>): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const field of MERGE_SCALARS) {
    if (!master[field] && duplicate[field]) updates[field] = duplicate[field];
  }
  const union = (a: unknown, b: unknown): unknown[] =>
    [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  for (const field of ["technologies", "intentSignals", "tags"] as const) {
    if (Array.isArray(master[field]) || Array.isArray(duplicate[field])) {
      const merged = union(master[field], duplicate[field]);
      if (merged.length > 0) updates[field] = merged;
    }
  }
  const object = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  for (const field of ["socialProfiles", "customFields"] as const) {
    const a = object(master[field]);
    const b = object(duplicate[field]);
    if (Object.keys(b).length) updates[field] = { ...b, ...a };
  }
  return updates;
}

export async function runDedupeJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  let duplicatesFound = 0;
  let duplicatesResolved = 0;

  try {
    const config = readDedupeConfig(job.config);

    const leads = await prisma.lead.findMany({
      where: { workspaceId: job.workspaceId },
      // Every field `planMerge` can carry over has to be in this select, or the
      // merge writes back blanks for data the duplicate actually had.
      select: {
        id: true, email: true, phone: true, linkedinUrl: true, firstName: true,
        lastName: true, company: true, title: true, department: true, seniority: true,
        location: true, country: true, industry: true, companySize: true, revenue: true,
        technologies: true, intentSignals: true, socialProfiles: true, customFields: true,
        tags: true, createdAt: true,
      },
    });

    const groups = findDuplicateGroups(leads, config.strategy, config.threshold);

    for (const group of groups) {
      if (group.length <= 1) continue;
      duplicatesFound += group.length - 1;

      const master = selectMasterRecord(group, config);
      const duplicates = group.filter(l => l.id !== master.id);

      for (const dup of duplicates) {
        await mergeRecords(master, dup, config.action || "merge", job.id);
        duplicatesResolved++;
      }
    }

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        progress: 100,
        // What was found and what was done with it. A COMPLETED job that found
        // duplicates and resolved none is visible here instead of implied.
        totalItems: duplicatesFound,
        processedItems: duplicatesResolved,
      },
    });
  } catch (error) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date(), error: error instanceof Error ? error.message : "Unknown error" },
    });
  }
}

function findDuplicateGroups(leads: any[], strategy: string, threshold?: number): any[][] {
  const groups: any[][] = [];
  const processed = new Set<string>();

  for (const lead of leads) {
    if (processed.has(lead.id)) continue;

    const group = [lead];
    processed.add(lead.id);

    for (const other of leads) {
      if (processed.has(other.id)) continue;
      if (areDuplicates(lead, other, strategy)) {
        group.push(other);
        processed.add(other.id);
      }
    }

    if (group.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}

function areDuplicates(a: any, b: any, strategy: string): boolean {
  switch (strategy) {
    case "email":
      return !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase();
    case "phone":
      return !!a.phone && !!b.phone && normalizePhone(a.phone) === normalizePhone(b.phone);
    case "linkedin":
      return !!a.linkedinUrl && !!b.linkedinUrl && a.linkedinUrl === b.linkedinUrl;
    case "company_name":
      return !!a.company && !!b.company && a.company.toLowerCase() === b.company.toLowerCase();
    case "fuzzy":
      return fuzzyMatch(a, b);
    default:
      return false;
  }
}

/**
 * Exported for unit tests: the comparison behind the `phone` strategy.
 *
 * Digits only, then a leading NANP `1` dropped, so all the spellings a CRM
 * stores for one number compare equal: `+1 (555) 010-0199`, `1-555-010-0199`
 * and `5550100199` are one number, and `+44 20 7946 0958` equals
 * `44 20 7946 0958` (the earlier `[^\d+]` kept the plus, so those two did
 * not match each other). Stripping the sign is safe for the same reason the
 * `+1` strip is: the digits identify the number.
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

function fuzzyMatch(a: any, b: any): boolean {
  // Simplified fuzzy matching - in production use a proper library like fuse.js
  const nameA = `${a.firstName || ""} ${a.lastName || ""}`.toLowerCase().trim();
  const nameB = `${b.firstName || ""} ${b.lastName || ""}`.toLowerCase().trim();
  if (!nameA || !nameB) return false;

  if (nameA === nameB) return true;

  // Check email similarity
  if (a.email && b.email) {
    const domainA = a.email.split("@")[1];
    const domainB = b.email.split("@")[1];
    if (domainA === domainB && levenshtein(nameA, nameB) <= 2) return true;
  }

  return false;
}

function levenshtein(a: string, b: string): number {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1,
        matrix[j][i - 1] + 1,
        matrix[j - 1][i - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

function selectMasterRecord(group: any[], config: any): any {
  if (config.keepOldest) {
    return group.reduce((oldest, current) => new Date(current.createdAt) < new Date(oldest.createdAt) ? current : oldest);
  }
  // Keep the most complete record
  return group.reduce((best, current) => {
    const bestScore = calculateCompleteness(best);
    const currentScore = calculateCompleteness(current);
    return currentScore > bestScore ? current : best;
  });
}

/**
 * Which of two duplicates is the survivor: the one whose *contact* fields a rep
 * could actually use. This is a tie-break between two rows, not `Lead.score`, and it
 * is deliberately weighted differently from `lib/lead-score.ts` — reaching a person
 * outranks knowing their industry there, and outranks it by more here, because a
 * duplicate nobody can email is the worse survivor. Renamed out of `score` so the one
 * arithmetic that prices a lead lives in one module; the test that pins that claim
 * reads this file.
 */
function calculateCompleteness(lead: any): number {
  let reachable = 0;
  if (lead.email) reachable += 20;
  if (lead.phone) reachable += 15;
  if (lead.linkedinUrl) reachable += 15;
  if (lead.firstName) reachable += 10;
  if (lead.lastName) reachable += 10;
  if (lead.company) reachable += 10;
  if (lead.title) reachable += 10;
  return reachable;
}

/**
 * Resolve one duplicate. The three actions are the ones the config names:
 *
 * - `merge` (the default): copy what the master is missing from the duplicate
 *   — scalars fill blanks, arrays union, object fields merge — then delete the
 *   duplicate. One enriched survivor.
 * - `delete`: delete the duplicate without copying anything.
 * - `flag`: keep both rows; tag the duplicate `duplicate` and leave a NOTE on
 *   its timeline naming the master, so a human decides.
 *
 * Measured before this: none of the three did anything. The branches were
 * comments, the job still counted every duplicate as resolved, and reported
 * COMPLETED on a list that had not changed.
 */
async function mergeRecords(master: any, duplicate: any, action: string, jobId: string): Promise<void> {
  if (action === "flag") {
    const tags = Array.isArray(duplicate.tags) ? duplicate.tags : [];
    await prisma.lead.update({
      where: { id: duplicate.id },
      data: { tags: [...new Set([...tags, "duplicate"])] },
    });
    await prisma.leadActivity.create({
      data: {
        leadId: duplicate.id,
        type: "NOTE",
        description: `Flagged as a possible duplicate of lead ${master.id}`,
        metadata: { duplicateOf: master.id, jobId },
      },
    });
    return;
  }

  if (action === "merge") {
    const updates = planMerge(master, duplicate);
    if (Object.keys(updates).length > 0) {
      // The survivor gained the duplicate's signals, so its score is the one the
      // merged row earns. `score` is not in `MERGE_SCALARS`: a merged lead does not
      // inherit a number, it re-earns one. (`flag` writes a tag, and a tag is not a
      // signal the score reads, so that branch leaves the number alone.)
      await prisma.lead.update({
        where: { id: master.id },
        data: { ...updates, ...scoredWriteData(rowAfterWrite(master, updates)) },
      });
    }
    await prisma.lead.delete({ where: { id: duplicate.id } });
    return;
  }

  // "delete": drop the duplicate outright — the master keeps exactly its own data.
  await prisma.lead.delete({ where: { id: duplicate.id } });
}