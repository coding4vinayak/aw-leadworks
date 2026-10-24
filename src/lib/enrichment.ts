import { prisma } from "./db";
import { enrichmentVisit, jobResultRow, progressValue } from "./job-report";
import { MARK, isMarked, startWrite, stoppedWrite } from "./job-stop";
import { queues, enqueue } from "./queue";
import { enqueueOrMark } from "./queue-refusal";
import { dispatchWebhookEvent } from "./webhooks";
import { leadMatches, leadWhere, readStoredConditions } from "./rule-conditions";
import { normalizeProviders } from "./enrichment-providers";
import { crowdWhere, namedLeads } from "./lead-crowd";
import { actionsProblem, restrictToDeclared } from "./rule-actions";
import { RULE_PRIORITY_ORDER, planTick, type DueRule } from "./rule-priority";
import { asInputJson } from "./json";
import { seniorityFromTitle } from "./seniority";
import { planEnrichmentWrite, type EnrichableLead } from "./enrich-plan";
import { PROVIDER_IMPLEMENTATIONS } from "./enrichment-providers-impl";

export interface EnrichmentConfig {
  providers: string[];
  /**
   * The columns this job's rule asked for — its `actions.fields`, copied in by the
   * door that queued it (`?action=run`, `scheduler.ts`, `runScheduledEnrichment`).
   * An empty list is not "no columns": it is the rule saying nothing about which
   * columns, which is how every job here was queued before the declaration was read,
   * and it is what the single-lead door sends. What a visit may write at all is
   * `lib/enrich-plan.ts`'s decision; this list can only narrow it further.
   */
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
   * The leads this job may visit, named by the door that queued it.
   * `POST /api/leads/{id}?action=enrich` names the one person its URL carries, and
   * the scheduler names the leads it counted into `totalItems`. Intersected with
   * `conditions` rather than replacing it, so naming a lead can only ever narrow
   * the crowd a rule declared. Read by `lib/lead-crowd.ts`, which is the same
   * discipline the validator's `VALIDATE` job uses — a job config is a JSON column
   * its caller wrote, and the workspace scope survives whatever the list holds.
   */
  leadIds?: unknown;
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

  // The mark, obeyed before anything begins: `not: MARK` is in the WHERE, so a cancel that
  // landed after the read above is not overwritten by this worker's own RUNNING.
  const began = await prisma.job.updateMany({
    where: { id: jobId, status: { not: MARK } },
    data: startWrite(new Date()),
  });
  if (!began.count) return;

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
  let stopped = false;

  for (const lead of leads) {
    // The mark, at the boundary before a row. `?action=cancel` wrote this row's status
    // and nothing read it back until now, so a cancelled job ran to COMPLETED over the
    // mark: the door was a suggestion. A row already in flight is finished — abandoning
    // one would leave a lead half-written and a record claiming nothing about it.
    if (isMarked(await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } }))) {
      stopped = true;
      break;
    }
    try {
      const answer = await enrichLead(lead, config);
      if (answer) {
        const written = await updateLeadEnrichment(job.workspaceId, lead, answer.columns, config.providers, ruleId);
        if (written.length > 0) enriched++;
        await prisma.jobResult.create({
          data: jobResultRow(jobId, enrichmentVisit(lead.id, {
            lead,
            written,
            declaredFields: config.fields ?? [],
            // What the providers named and what the rule's `fields` allowed through are
            // two different sets, and only the first is "what came back". Reporting the
            // narrowed one as the answer is how a visit ended up claiming a provider
            // named nothing when the rule had simply refused to name it.
            named: answer.named,
            answered: Object.keys(answer.columns),
          })),
        });
      } else {
        await prisma.jobResult.create({
          data: jobResultRow(jobId, {
            leadId: lead.id,
            status: "SKIPPED",
            data: {
              reason: "no provider returned an answer",
              asked: config.providers,
            },
          }),
        });
      }
      processed++;
    } catch (error) {
      failed++;
      await logEnrichmentError(job.workspaceId, lead.id, error, ruleId);
      await prisma.jobResult.create({
        data: jobResultRow(jobId, {
          leadId: lead.id,
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }

    // Counted as it goes — the denominator included, so a row read between two leads is
    // a share of a crowd rather than a bare RUNNING — and written with the mark in its
    // WHERE, because a cancel that lands while this lead is in flight must not be walked
    // back to a status by the progress stamp that follows it.
    await prisma.job.updateMany({
      where: { id: jobId, status: { not: MARK } },
      data: {
        totalItems: leads.length,
        progress: progressValue({ total: leads.length, processed, failed }),
        processedItems: processed,
        failedItems: failed,
      },
    });
  }

  const counters = { total: leads.length, processed, failed };
  const finish = await prisma.job.updateMany({
    // A stop writes under the mark; a finish writes around it. Either way the operator's
    // word is the one that survives.
    where: { id: jobId, status: stopped ? MARK : { not: MARK } },
    data: stopped
      ? stoppedWrite(counters, new Date())
      : {
        status: "COMPLETED", completedAt: new Date(),
        // The denominator is written by the hand that computed it. `totalItems` used to
        // exist only when a door stamped one at create time, so a job that visited 16
        // rows reported `totalItems: 0` next to `progress: 100`.
        totalItems: leads.length,
        progress: progressValue(counters),
        processedItems: processed,
        failedItems: failed,
      },
  });
  // The window between the last boundary check and that statement is one row's work wide,
  // and a cancel landing inside it used to be answered with a COMPLETED nobody asked for.
  // Matching nothing is the row saying the mark, so the stop is written with the counters
  // this worker actually holds — the same arithmetic the loop would have stamped next.
  if (!finish.count && !stopped) {
    await prisma.job.updateMany({ where: { id: jobId, status: MARK }, data: stoppedWrite(counters, new Date()) });
  }

  // After the write that makes the event true, and bounded: the dispatcher
  // never throws and each delivery carries a 5s abort, so a receiver that is
  // down cannot fail a job whose real work has committed.
  //
  // A job that obeyed the mark does not send it. `enrichment.completed` is the whole
  // list of event names this application can dispatch, and the word in it is
  // "completed": a stopped job that announced itself would teach every subscriber to
  // expect leads that were never visited. The stop is on the row and in the records of
  // the rows it did — an operator reading the job sees it, a caller polling the list
  // sees it, and nothing downstream is told a finish that did not happen.
  if (!stopped) {
    await dispatchWebhookEvent(job.workspaceId, "enrichment.completed", {
      jobId: job.id,
      processed,
      enriched,
      failed,
    });
  }
}

async function getLeadsToEnrich(workspaceId: string, config: EnrichmentConfig): Promise<any[]> {
  const crowd = namedLeads(config.leadIds);
  const stored = readStoredConditions(config.conditions);
  if (stored.problem !== null) {
    console.warn(`Enrichment job skipped: the conditions it carries cannot be read — ${stored.problem}`);
    return [];
  }
  const leads = await prisma.lead.findMany({
    where: crowdWhere(leadWhere(workspaceId, stored.conditions), crowd),
    take: 1000,
  });
  // The `where` and this predicate are two readings of one declaration, and what
  // comes back from here is a row the app is about to write to. Where a stored row
  // defeats the SQL translation — a `tags` column holding something other than the
  // array the column promises — the person is left alone. Filtering can only narrow.
  return leads.filter((lead) => leadMatches(stored.conditions, lead));
}

/** A provider's answer, in the two sets the record of the visit needs to be honest. */
export interface EnrichmentAnswer {
  /** Every column a provider named. */
  named: string[];
  /** The named ones this rule's `fields` allowed through — what may be written. */
  columns: EnrichmentResult;
}

async function enrichLead(lead: any, config: EnrichmentConfig): Promise<EnrichmentAnswer | null> {
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
  // The rule's declaration then narrows the answer: `actions.fields` names the
  // columns this rule asked for, and a provider's opinion about any other column is
  // not written into anybody's row. The visit itself is real and is still recorded —
  // `lib/enrich-plan.ts` stamps it and logs `PARTIAL` with nothing in it, which is
  // the honest shape of "a provider answered, the rule wanted something else". An
  // empty list means the rule said nothing about columns, and nothing is removed.
  // Both sets go out, because the record has to say which of the two emptied it.
  return { named: Object.keys(results), columns: restrictToDeclared(results, config.fields) };
}

async function enrichWithProvider(lead: any, provider: string, fields: string[]): Promise<Partial<EnrichmentResult> | null> {
  const impl = PROVIDER_IMPLEMENTATIONS[provider];
  if (!impl) {
    console.warn(`Unknown enrichment provider: ${provider}`);
    return null;
  }
  return impl(lead, fields);
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
): Promise<string[]> {
  const plan = planEnrichmentWrite(lead, result);
  await prisma.lead.update({ where: { id: lead.id }, data: plan.data });

  await prisma.enrichmentLog.create({
    data: {
      workspaceId,
      ruleId,
      leadId: lead.id,
      provider: providers.join(","),
      fieldsEnriched: plan.written,
      beforeData: asInputJson(plan.before),
      afterData: Object.fromEntries(plan.written.map((column) => [column, result[column]])),
      status: plan.logStatus,
      creditsUsed: providers.length,
    },
  });

  return plan.written;
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
      // The ids travel with the count. This function used to write
      // `totalItems: leadIds.length` and pass the crowd only as an argument the
      // worker never saw, so a job whose row promised 100 leads went and re-derived
      // its own crowd from the rule's conditions — two answers to "how many did you
      // visit" for one job.
      type: "ENRICH",
      status: "PENDING",
      config: asInputJson({ ...config, leadIds }),
      totalItems: leadIds.length,
    },
  });

  // A bulk run asked for a row on the spot; if the queue refuses it, the row says so rather
  // than joining the `PENDING` rows nothing will ever run.
  await enqueueOrMark(job.id, () => enqueue(queues.enrich, "run-enrichment", { jobId: job.id }));
}

export async function runScheduledEnrichment(): Promise<void> {
  const rules = await prisma.enrichmentRule.findMany({
    where: { isActive: true, trigger: "SCHEDULED" },
    include: { workspace: true },
    orderBy: RULE_PRIORITY_ORDER,
  });

  // The same walk `scheduler.ts` does. This copy has no cadence check — that file is the
  // function the minute actually runs — but it must not decide a different set of owners
  // for the same columns, because two rules visiting one lead for one column is the thing
  // `priority` exists to settle.
  const due: DueRule[] = [];
  for (const rule of rules) {
    const stored = readStoredConditions(rule.conditions);
    if (stored.problem !== null) {
      console.warn(`Enrichment rule ${rule.id} skipped: conditions cannot be read — ${stored.problem}`);
      continue;
    }
    // The rule's own words about what to perform, read the way the sweep reads them: this
    // copy must not queue a visit that ignores the columns the rule named, nor one whose
    // declaration nothing can honour.
    const performed = actionsProblem(rule.actions);
    if (performed !== null) {
      console.warn(`Enrichment rule ${rule.id} skipped: its actions cannot be performed — ${performed}`);
      continue;
    }
    due.push({
      id: rule.id,
      workspaceId: rule.workspaceId,
      createdAt: rule.createdAt,
      priority: rule.priority,
      actions: rule.actions,
      providers: Array.isArray(rule.providers) ? (rule.providers as unknown as string[]) : [],
      conditions: stored.conditions,
    });
  }

  const plan = planTick(due);
  for (const starved of plan.starved) {
    console.info(
      `Enrichment rule ${starved.rule.id} queued nothing: every column ${
        starved.asked === null ? "it could write" : `it asked for (${starved.asked.join(", ")})`
      } is owned by a higher-ranked rule`,
    );
  }

  for (const { rule, fields } of plan.visits) {
    const leads = await prisma.lead.findMany({
      where: leadWhere(rule.workspaceId, rule.conditions),
      take: 100,
    });

    if (leads.length > 0) {
      await runBulkEnrichment(rule.workspaceId, leads.map(l => l.id), {
        providers: rule.providers,
        fields,
        conditions: rule.conditions,
        ruleId: rule.id,
      });
    }
  }
}