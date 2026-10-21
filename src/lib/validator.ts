import { prisma } from "./db";
import { rowAfterWrite, scoredWriteData } from "./lead-score";

/**
 * `flag` and `score_down` are one thing now: the validator records what failed on
 * the row, and `lib/lead-score.ts` prices the recorded failures. Both words are
 * still accepted, and neither is a subtraction this worker performs — see the note
 * in `runValidateJob`. `remove` deletes the row instead of recording on it.
 *
 * `leadIds` names the crowd. Without it the job walks every lead in the workspace,
 * which is a lot of rows to re-price — or delete — on the strength of one POST.
 */
export interface ValidateConfig {
  checks: ("email_format" | "email_deliverability" | "phone_format" | "phone_carrier" | "linkedin_format" | "linkedin_exists" | "company_exists" | "domain_valid")[];
  action?: "flag" | "remove" | "score_down";
  leadIds?: unknown;
}

/**
 * The ids a job was told to check, or `null` for "the whole workspace". A job's
 * `config` is caller-writable, so this is read as the untrusted thing it is:
 * non-strings are dropped and the query stays scoped to the job's own workspace
 * whichever way it goes, which measured as `leadIds: ["mine", "someone-else's"]`
 * checking one lead and no other tenant's.
 */
export function namedLeads(config: ValidateConfig): string[] | null {
  if (!Array.isArray(config.leadIds)) return null;
  const ids = config.leadIds.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  return ids.length > 0 ? [...new Set(ids)] : null;
}

export async function runValidateJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as ValidateConfig;
  const crowd = namedLeads(config);
  const leads = await prisma.lead.findMany({
    where: crowd ? { workspaceId: job.workspaceId, id: { in: crowd } } : { workspaceId: job.workspaceId },
  });
  let validated = 0;
  let failed = 0;
  let flagged = 0;

  for (const lead of leads) {
    try {
      const results = await validateLead(lead, config);
      const failedChecks = results.filter(r => !r.valid);

      if (failedChecks.length > 0 && config.action === "remove") {
        // The row is gone, so there is nothing left to record on it. Measured
        // before: the delete ran and then this same loop wrote `validationResults`
        // to the deleted id, Prisma threw P2025, the catch counted the lead in
        // `failedItems` and the job reported COMPLETED having destroyed a lead it
        // claims it could not process.
        await prisma.lead.delete({ where: { id: lead.id } });
        flagged++;
        validated++;
        continue;
      }

      // One write, and the score is recomputed rather than decremented.
      // `validationResults` is overwritten here, which is the only reason
      // `lead-score.ts` can read it as an input: the score stays a function of the
      // row, so checking the same data twice cannot lower it twice. The branch this
      // replaces was `score: Math.max(0, lead.score - failedChecks.length * 10)`
      // against whatever number the column held — a score that decayed once per
      // validation run, always from the 0 every lead arrives with, so it could only
      // ever stay 0.
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          validationResults: results,
          ...scoredWriteData(rowAfterWrite(lead, { validationResults: results })),
        },
      });
      if (failedChecks.length > 0) flagged++;

      validated++;
    } catch (error) {
      failed++;
    }
  }

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "COMPLETED", completedAt: new Date(), progress: 100, processedItems: validated, failedItems: failed },
  });
}

interface ValidationResult {
  check: string;
  valid: boolean;
  message?: string;
  confidence?: number;
}

async function validateLead(lead: any, config: any): Promise<any[]> {
  const results: any[] = [];
  const checks = config.checks || ["email_format", "phone_format", "linkedin_format"];

  for (const check of checks) {
    let result: any = { check, valid: false };
    switch (check) {
      case "email_format":
        result = validateEmailFormat(lead.email);
        break;
      case "email_deliverability":
        result = await validateEmailDeliverability(lead.email);
        break;
      case "phone_format":
        result = validatePhoneFormat(lead.phone);
        break;
      case "phone_carrier":
        result = await validatePhoneCarrier(lead.phone);
        break;
      case "linkedin_format":
        result = validateLinkedInFormat(lead.linkedinUrl);
        break;
      case "linkedin_exists":
        result = await validateLinkedInExists(lead.linkedinUrl);
        break;
      case "company_exists":
        result = await validateCompanyExists(lead.company);
        break;
      case "domain_valid":
        result = await validateDomainValid(lead.email);
        break;
      default:
        continue;
    }
    results.push(result);
  }
  return results;
}

function validateEmailFormat(email?: string): { check: string; valid: boolean; message?: string; confidence?: number } {
  if (!email) return { check: "email_format", valid: false, message: "Email is required", confidence: 1 };
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid = emailRegex.test(email);
  return { check: "email_format", valid, message: valid ? undefined : "Invalid email format", confidence: 1 };
}

async function validateEmailDeliverability(email?: string): Promise<any> {
  if (!email) return { check: "email_deliverability", valid: false, message: "No email provided" };
  // Would integrate with email verification service (ZeroBounce, NeverBounce, etc.)
  // For now, basic syntax + domain check
  const domain = email.split("@")[1];
  if (!domain) return { check: "email_deliverability", valid: false, message: "No domain" };

  try {
    // Would do MX record lookup
    return { check: "email_deliverability", valid: true, confidence: 0.8 };
  } catch {
    return { check: "email_deliverability", valid: false, message: "Domain not found", confidence: 0.5 };
  }
}

function validatePhoneFormat(phone?: string): any {
  if (!phone) return { check: "phone_format", valid: false, message: "Phone is required", confidence: 1 };
  const e164Regex = /^\+?[1-9]\d{1,14}$/;
  const valid = e164Regex.test(phone.replace(/[\s\-\(\)]/g, ""));
  return { check: "phone_format", valid, message: valid ? undefined : "Invalid E.164 format", confidence: 1 };
}

async function validatePhoneCarrier(phone?: string): Promise<any> {
  if (!phone) return { check: "phone_carrier", valid: false, message: "No phone provided" };
  // Would integrate with carrier lookup service (Twilio Lookup, NumVerify, etc.)
  return { check: "phone_carrier", valid: true, confidence: 0.7, message: "Carrier lookup placeholder" };
}

function validateLinkedInFormat(linkedinUrl?: string): any {
  if (!linkedinUrl) return { check: "linkedin_format", valid: false, message: "LinkedIn URL is required", confidence: 1 };
  const linkedinRegex = /^https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/;
  const valid = linkedinRegex.test(linkedinUrl);
  return { check: "linkedin_format", valid, message: valid ? undefined : "Invalid LinkedIn profile URL format", confidence: 1 };
}

async function validateLinkedInExists(linkedinUrl?: string): Promise<any> {
  if (!linkedinUrl) return { check: "linkedin_exists", valid: false, message: "No LinkedIn URL" };
  // Would call LinkedIn API or scrape to verify
  return { check: "linkedin_exists", valid: true, confidence: 0.6, message: "Existence check placeholder" };
}

async function validateCompanyExists(company?: string): Promise<any> {
  if (!company) return { check: "company_exists", valid: false, message: "No company name" };
  // Would integrate with company database (Clearbit, Apollo, etc.)
  return { check: "company_exists", valid: true, confidence: 0.7, message: "Company verification placeholder" };
}

async function validateDomainValid(email?: string): Promise<any> {
  if (!email) return { check: "domain_valid", valid: false, message: "No email" };
  const domain = email.split("@")[1];
  if (!domain) return { check: "domain_valid", valid: false, message: "No domain" };

  // Would do DNS MX record check
  return { check: "domain_valid", valid: true, confidence: 0.8, message: "Domain MX check placeholder" };
}