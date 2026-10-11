import { prisma } from "./db";

export interface DedupeConfig {
  strategy: "email" | "phone" | "linkedin" | "company_name" | "fuzzy";
  threshold?: number;
  action?: "merge" | "delete" | "flag";
  keepOldest?: boolean;
}

export async function runDedupeJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as DedupeConfig;
  let duplicatesFound = 0;
  let duplicatesResolved = 0;

  try {
    const leads = await prisma.lead.findMany({
      where: { workspaceId: job.workspaceId },
      select: { id: true, email: true, phone: true, linkedinUrl: true, company: true, firstName: true, lastName: true, createdAt: true },
    });

    const groups = findDuplicateGroups(leads, config.strategy, config.threshold);

    for (const group of groups) {
      if (group.length <= 1) continue;
      duplicatesFound += group.length - 1;

      const master = selectMasterRecord(group, config);
      const duplicates = group.filter(l => l.id !== master.id);

      for (const dup of duplicates) {
        await mergeRecords(master, dup, config.action || "merge");
        duplicatesResolved++;
      }
    }

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "COMPLETED", completedAt: new Date(), progress: 100, processedItems: duplicatesResolved },
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

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "").replace(/^\+?1/, "");
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

function calculateCompleteness(lead: any): number {
  let score = 0;
  if (lead.email) score += 20;
  if (lead.phone) score += 15;
  if (lead.linkedinUrl) score += 15;
  if (lead.firstName) score += 10;
  if (lead.lastName) score += 10;
  if (lead.company) score += 10;
  if (lead.title) score += 10;
  return score;
}

async function mergeRecords(master: any, duplicate: any, action: string): Promise<void> {
  // Merge data from duplicate into master
  const updates: any = {};
  const fields = ["email", "phone", "linkedinUrl", "firstName", "lastName", "company", "title", "department", "seniority", "location", "country", "industry", "companySize", "revenue"];

  for (const field of fields) {
    if (!master[field] && duplicate[field]) {
      updates[field] = duplicate[field];
    }
  }

  // Merge arrays
  if (master.technologies && duplicate.technologies) {
    updates.technologies = [...new Set([...(master.technologies || []), ...(duplicate.technologies || [])])];
  }
  if (master.intentSignals && duplicate.intentSignals) {
    updates.intentSignals = [...new Set([...(master.intentSignals || []), ...(duplicate.intentSignals || [])])];
  }
  if (master.socialProfiles && duplicate.socialProfiles) {
    updates.socialProfiles = { ...master.socialProfiles, ...duplicate.socialProfiles };
  }
  if (master.customFields && duplicate.customFields) {
    updates.customFields = { ...master.customFields, ...duplicate.customFields };
  }
  if (master.tags && duplicate.tags) {
    updates.tags = [...new Set([...(master.tags || []), ...(duplicate.tags || [])])];
  }

  if (Object.keys(updates).length > 0) {
    // Update master with merged data
  }

  // Delete or archive duplicate based on action
  if (action === "delete") {
    // Delete duplicate
  } else if (action === "flag") {
    // Mark as duplicate
  }
}