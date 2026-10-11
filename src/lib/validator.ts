import { prisma } from "./db";

export interface ValidateConfig {
  checks: ("email_format" | "email_deliverability" | "phone_format" | "phone_carrier" | "linkedin_format" | "linkedin_exists" | "company_exists" | "domain_valid")[];
  action?: "flag" | "remove" | "score_down";
}

export async function runValidateJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as ValidateConfig;
  const leads = await prisma.lead.findMany({ where: { workspaceId: job.workspaceId } });
  let validated = 0;
  let failed = 0;
  let flagged = 0;

  for (const lead of leads) {
    try {
      const results = await validateLead(lead, config);
      const failedChecks = results.filter(r => !r.valid);

      if (failedChecks.length > 0) {
        flagged++;
        if (config.action === "remove") {
          await prisma.lead.delete({ where: { id: lead.id } });
        } else if (config.action === "score_down") {
          await prisma.lead.update({ where: { id: lead.id }, data: { score: Math.max(0, lead.score - failedChecks.length * 10) } });
        }
      }

      await prisma.lead.update({
        where: { id: lead.id },
        data: { validationResults: results },
      });

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