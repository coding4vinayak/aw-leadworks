import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { dispatchWebhookEvent } from "./webhooks";
import { leadMatches, leadWhere, readStoredConditions } from "./rule-conditions";
import { normalizeProviders } from "./enrichment-providers";
import { seniorityFromTitle } from "./seniority";
import { planEnrichmentWrite, type EnrichableLead } from "./enrich-plan";

export interface EnrichmentConfig {
  providers: string[];
  fields: string[];
  confidenceThreshold?: number;
  /**
   * The rule's `conditions`, copied in by the door that queued this job
   * (`scheduler.ts`, `?action=run`). A job that carries none — the single-lead
   * `?action=enrich`, an old row, a bulk call from the UI — is enriched the way
   * LeadWorks has always enriched it. Held as `unknown` because a job config is a
   * JSON column like any other: this function decides what a bad one means.
   */
  conditions?: unknown;
  /**
   * The rule that queued this job, carried in by `?action=run` and the scheduler.
   * It decides which workspace's rule page the visit shows up on, so it is checked
   * against the job's own workspace rather than trusted: a name that does not exist
   * would fail every log write in the job, and a foreign rule would leak this
   * workspace's visits onto someone else's rule.
   */
  ruleId?: unknown;
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
  [key: string]: any;
}

export async function runEnrichmentJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as EnrichmentConfig;
  // A rule's `providers` is stored text: normalise the spelling once for the job,
  // so a rule that lists `Apollo` reaches the case dispatching on `apollo` and a
  // name nothing implements is not handed to the worker at all. This rewrites the
  // parsed config, not the Job row — the row stays what its caller sent.
  config.providers = normalizeProviders(config.providers);
  const ruleId = await usableRuleId(job.workspaceId, config.ruleId);
  const leads = await getLeadsToEnrich(job.workspaceId, config);
  let processed = 0;
  let enriched = 0;
  let failed = 0;

  for (const lead of leads) {
    try {
      const result = await enrichLead(lead, config);
      if (result) {
        const written = await updateLeadEnrichment(job.workspaceId, lead, result, config.providers, ruleId);
        if (written > 0) enriched++;
      }
      processed++;
    } catch (error) {
      failed++;
      await logEnrichmentError(job.workspaceId, lead.id, error, ruleId);
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
  const stored = readStoredConditions(config.conditions);
  if (stored.problem !== null) {
    console.warn(`Enrichment job skipped: the conditions it carries cannot be read — ${stored.problem}`);
    return [];
  }
  const leads = await prisma.lead.findMany({ where: leadWhere(workspaceId, stored.conditions), take: 1000 });
  // The `where` and this predicate are two readings of one declaration, and what
  // comes back from here is a row the app is about to write to. Where a stored row
  // defeats the SQL translation — a `tags` column holding something other than the
  // array the column promises — the person is left alone. Filtering can only narrow.
  return leads.filter((lead) => leadMatches(stored.conditions, lead));
}

async function enrichLead(lead: any, config: EnrichmentConfig): Promise<EnrichmentResult | null> {
  const results: EnrichmentResult = {};
  let answered = 0;

  for (const provider of config.providers) {
    try {
      const result = await enrichWithProvider(lead, provider, config.fields);
      if (result) {
        Object.assign(results, result);
        answered++;
      }
    } catch (error) {
      console.error(`Enrichment failed for provider ${provider}:`, error);
    }
  }

  // Nothing answered, so there is nothing to record — not even a timestamp, which
  // would otherwise claim a visit that never happened.
  if (answered === 0) return null;
  return results;
}

async function enrichWithProvider(lead: any, provider: string, fields: string[]): Promise<Partial<EnrichmentResult> | null> {
  switch (provider) {
    case "derive":
      return deriveFromRow(lead, fields);
    // The call sites a key belongs in. Each is dispatched; none of them returns a
    // value, because an unconfigured provider that answers with an invented
    // `industry: "SaaS"` writes fiction into a customer's row, which is worse than
    // the silence these now keep. See `src/lib/enrichment-providers.ts`.
    case "apollo":
    case "clearbit":
    case "hunter":
    case "linkedin":
    case "clearbit_company":
    case "apollo_company":
      return null;
    default:
      return null;
  }
}

/**
 * The one provider that works without credentials: it reads the row the workspace
 * already has and answers with what that row states. A title naming a
 * `Director of Engineering` says a rung of `Lead.seniority` that nobody typed, and
 * `seniority.ts` abstains rather than guessing when the title is not in its table.
 * `fields` is the list the rule asked for; a derivation that is not on it is still
 * something the row already told us, so it is offered either way and the write plan
 * decides whether the column has a gap for it.
 */
async function deriveFromRow(lead: any, _fields: string[]): Promise<Partial<EnrichmentResult>> {
  const seniority = seniorityFromTitle(lead.title);
  return seniority === null ? {} : { seniority };
}

/** The rule a job may be logged against, or `null` when no rule of this workspace queued it. */
async function usableRuleId(workspaceId: string, claimed: unknown): Promise<string | null> {
  if (typeof claimed !== "string" || claimed === "") return null;
  const owned = await prisma.enrichmentRule.findFirst({ where: { id: claimed, workspaceId }, select: { id: true } });
  return owned?.id ?? null;
}

async function updateLeadEnrichment(
  workspaceId: string,
  lead: EnrichableLead & { id: string },
  result: EnrichmentResult,
  providers: string[],
  ruleId: string | null,
): Promise<number> {
  const plan = planEnrichmentWrite(lead, result);
  await prisma.lead.update({ where: { id: lead.id }, data: plan.data });

  await prisma.enrichmentLog.create({
    data: {
      workspaceId,
      ruleId,
      leadId: lead.id,
      provider: providers.join(","),
      fieldsEnriched: plan.written,
      afterData: Object.fromEntries(plan.written.map((column) => [column, result[column]])),
      status: plan.logStatus,
      creditsUsed: providers.length,
    },
  });

  return plan.written.length;
}

async function logEnrichmentError(workspaceId: string, leadId: string, error: unknown, ruleId: string | null): Promise<void> {
  await prisma.enrichmentLog.create({
    data: {
      workspaceId,
      ruleId,
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
    const stored = readStoredConditions(rule.conditions);
    if (stored.problem !== null) {
      console.warn(`Enrichment rule ${rule.id} skipped: conditions cannot be read — ${stored.problem}`);
      continue;
    }
    const leads = await prisma.lead.findMany({
      where: leadWhere(rule.workspaceId, stored.conditions),
      take: 100,
    });

    if (leads.length > 0) {
      await runBulkEnrichment(rule.workspaceId, leads.map(l => l.id), {
        providers: (rule.providers as string[]) || [],
        fields: [],
        conditions: stored.conditions,
        ruleId: rule.id,
      });
    }
  }
}