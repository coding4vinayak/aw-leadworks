import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { dispatchWebhookEvent } from "./webhooks";

export interface EnrichmentConfig {
  providers: string[];
  fields: string[];
  confidenceThreshold?: number;
  [key: string]: any;
}

export interface EnrichmentResult {
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  department?: string;
  seniority?: string;
  location?: string;
  country?: string;
  industry?: string;
  companySize?: string;
  revenue?: string;
  technologies?: string[];
  intentSignals?: string[];
  socialProfiles?: Record<string, string>;
  confidence?: number;
  [key: string]: any;
}

export async function runEnrichmentJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as EnrichmentConfig;
  const leads = await getLeadsToEnrich(job.workspaceId, config);
  let processed = 0;
  let enriched = 0;
  let failed = 0;

  for (const lead of leads) {
    try {
      const result = await enrichLead(lead, config);
      if (result) {
        await updateLeadEnrichment(lead.id, result, config.providers);
        enriched++;
      }
      processed++;
    } catch (error) {
      failed++;
      await logEnrichmentError(job.workspaceId, lead.id, error);
    }

    await prisma.job.update({
      where: { id: jobId },
      data: { processedItems: processed, failedItems: failed },
    });
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "COMPLETED", completedAt: new Date(), progress: 100, processedItems: processed, failedItems: failed },
  });

  // After the write that makes the event true, and bounded: the dispatcher
  // never throws and each delivery carries a 5s abort, so a receiver that is
  // down cannot fail a job whose real work has committed.
  await dispatchWebhookEvent(job.workspaceId, "enrichment.completed", {
    jobId: job.id,
    processed,
    enriched,
    failed,
  });
}

async function getLeadsToEnrich(workspaceId: string, config: EnrichmentConfig): Promise<any[]> {
  const where: any = { workspaceId, status: { in: ["NEW", "ENRICHED"] } };
  if (config.fields.length > 0) {
    // Add logic to filter by missing fields
  }
  return prisma.lead.findMany({ where, take: 1000 });
}

async function enrichLead(lead: any, config: EnrichmentConfig): Promise<EnrichmentResult | null> {
  const results: EnrichmentResult = {};
  let totalConfidence = 0;
  let providerCount = 0;

  for (const provider of config.providers) {
    try {
      const result = await enrichWithProvider(lead, provider, config.fields);
      if (result) {
        Object.assign(results, result);
        totalConfidence += result.confidence || 0.5;
        providerCount++;
      }
    } catch (error) {
      console.error(`Enrichment failed for provider ${provider}:`, error);
    }
  }

  if (providerCount === 0) return null;
  return { ...results, confidence: totalConfidence / providerCount };
}

async function enrichWithProvider(lead: any, provider: string, fields: string[]): Promise<Partial<EnrichmentResult> | null> {
  switch (provider) {
    case "apollo":
      return await enrichWithApollo(lead, fields);
    case "clearbit":
      return await enrichWithClearbit(lead, fields);
    case "hunter":
      return await enrichWithHunter(lead, fields);
    case "linkedin":
      return await enrichWithLinkedIn(lead, fields);
    case "clearbit_company":
      return await enrichCompanyWithClearbit(lead, fields);
    case "apollo_company":
      return await enrichCompanyWithApollo(lead, fields);
    default:
      return null;
  }
}

async function enrichWithApollo(lead: any, fields: string[]): Promise<Partial<EnrichmentResult>> {
  // Apollo.io API integration
  // Would call Apollo API with email/domain
  return { confidence: 0.7 };
}

async function enrichWithClearbit(lead: any, fields: string[]): Promise<Partial<EnrichmentResult>> {
  // Clearbit API integration
  return { confidence: 0.8 };
}

async function enrichWithHunter(lead: any, fields: string[]): Promise<Partial<EnrichmentResult>> {
  // Hunter.io API integration
  return { confidence: 0.75 };
}

async function enrichWithLinkedIn(lead: any, fields: string[]): Promise<Partial<EnrichmentResult>> {
  // LinkedIn API or scraping
  return { confidence: 0.6 };
}

async function enrichCompanyWithClearbit(lead: any, fields: string[]): Promise<Partial<EnrichmentResult>> {
  // Company enrichment via Clearbit
  return { companySize: "51-200", industry: "SaaS", technologies: ["React", "Node.js"], confidence: 0.8 };
}

async function enrichCompanyWithApollo(lead: any, fields: string[]): Promise<Partial<EnrichmentResult>> {
  return { companySize: "201-500", industry: "Technology", revenue: "$10M-$50M", confidence: 0.75 };
}

async function updateLeadEnrichment(leadId: string, result: EnrichmentResult, providers: string[]): Promise<void> {
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      ...result,
      lastEnrichedAt: new Date(),
      score: calculateLeadScore(result),
    },
  });

  await prisma.enrichmentLog.create({
    data: {
      workspaceId: "", // Would need to pass workspace
      leadId,
      provider: providers.join(","),
      fieldsEnriched: Object.keys(result).filter(k => k !== "confidence"),
      afterData: result,
      status: "SUCCESS",
      creditsUsed: providers.length,
    },
  });
}

function calculateLeadScore(result: EnrichmentResult): number {
  let score = 0;
  if (result.email) score += 20;
  if (result.phone) score += 15;
  if (result.linkedinUrl) score += 15;
  if (result.title) score += 10;
  if (result.company) score += 10;
  if (result.technologies?.length) score += 10;
  if (result.intentSignals?.length) score += 10;
  if (result.confidence && result.confidence > 0.7) score += 5;
  return Math.min(score, 100);
}

async function logEnrichmentError(workspaceId: string, leadId: string, error: unknown): Promise<void> {
  await prisma.enrichmentLog.create({
    data: {
      workspaceId,
      leadId,
      provider: "unknown",
      fieldsEnriched: [],
      status: "FAILED",
      error: error instanceof Error ? error.message : "Unknown error",
    },
  });
}

export async function runBulkEnrichment(workspaceId: string, leadIds: string[], config: EnrichmentConfig): Promise<void> {
  const job = await prisma.job.create({
    data: {
      workspaceId,
      type: "ENRICH",
      status: "PENDING",
      config,
      totalItems: leadIds.length,
    },
  });

  await enqueue(queues.enrich, "run-enrichment", { jobId: job.id });
}

export async function runScheduledEnrichment(): Promise<void> {
  const rules = await prisma.enrichmentRule.findMany({
    where: { isActive: true, trigger: "SCHEDULED" },
    include: { workspace: true },
  });

  for (const rule of rules) {
    // Check schedule - simplified
    const now = new Date();
    const cronParts = rule.actions; // Would parse schedule from rule config
    // Simplified - run every hour
    const leads = await prisma.lead.findMany({
      where: { workspaceId: rule.workspaceId, status: { in: ["NEW", "ENRICHED"] } },
      take: 100,
    });

    if (leads.length > 0) {
      await runBulkEnrichment(rule.workspaceId, leads.map(l => l.id), {
        providers: (rule.providers as string[]) || [],
        fields: [],
      });
    }
  }
}