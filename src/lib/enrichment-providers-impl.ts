import type { EnrichmentResult } from "./enrichment";

/**
 * Provider implementations for enrichment.
 *
 * Each provider function takes a lead and the fields requested, and returns
 * the enrichment data. If the provider is not configured (missing API key)
 * or fails, it returns null rather than throwing, so the enrichment job
 * continues with other providers.
 *
 * All functions are pure-ish: they take inputs and return results, no side
 * effects other than network calls.
 */

/**
 * Apollo.io enrichment - person and company enrichment.
 * Docs: https://apollo.io/api-docs
 */
export async function enrichWithApollo(
  lead: any,
  _fields: string[],
): Promise<Partial<EnrichmentResult> | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    // Apollo People Search - find by email or name+company
    const searchParams = new URLSearchParams();
    if (lead.email) searchParams.set("email", lead.email);
    if (lead.firstName && lead.lastName) {
      searchParams.set("first_name", lead.firstName);
      searchParams.set("last_name", lead.lastName);
    }
    if (lead.company) searchParams.set("organization_name", lead.company);
    if (lead.linkedinUrl) searchParams.set("linkedin_url", lead.linkedinUrl);

    const r = await fetch(`https://api.apollo.io/api/v1/people/search?${searchParams}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!r.ok) {
      console.warn(`Apollo API error: ${r.status} ${r.statusText}`);
      return null;
    }

    const data = await r.json();
    const person = data.people?.[0];
    if (!person) return null;

    const result: Partial<EnrichmentResult> = {};
    if (person.email && !lead.email) result.email = person.email;
    if (person.phone_numbers?.[0]?.sanitized_phone && !lead.phone) result.phone = person.phone_numbers[0].sanitized_phone;
    if (person.linkedin_url && !lead.linkedinUrl) result.linkedinUrl = person.linkedin_url;
    if (person.first_name && !lead.firstName) result.firstName = person.first_name;
    if (person.last_name && !lead.lastName) result.lastName = person.last_name;
    if (person.title && !lead.title) result.title = person.title;
    if (person.seniority && !lead.seniority) result.seniority = person.seniority;
    if (person.department && !lead.department) result.department = person.department;
    if (person.location && !lead.location) result.location = person.location;
    if (person.city && !lead.location) result.location = person.city;
    if (person.state && !lead.location) result.location = (result.location || "") + (result.location ? ", " : "") + person.state;
    if (person.country && !lead.country) result.country = person.country;

    // Company enrichment
    if (person.organization) {
      const org = person.organization;
      if (org.name && !lead.company) result.company = org.name;
      if (org.industry && !lead.industry) result.industry = org.industry;
      if (org.estimated_num_employees && !lead.companySize) result.companySize = String(org.estimated_num_employees);
      if (org.annual_revenue && !lead.revenue) result.revenue = String(org.annual_revenue);
      if (org.technologies?.length) {
        const techNames = org.technologies.map((t: any) => t.name).filter(Boolean);
        if (techNames.length) result.technologies = techNames;
      }
      if (org.linkedin_url && !lead.linkedinUrl) result.linkedinUrl = org.linkedin_url;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    console.warn("Apollo enrichment failed:", error);
    return null;
  }
}

/**
 * Clearbit Enrichment - person and company enrichment.
 * Docs: https://dashboard.clearbit.com/docs
 */
export async function enrichWithClearbit(
  lead: any,
  _fields: string[],
): Promise<Partial<EnrichmentResult> | null> {
  const apiKey = process.env.CLEARBIT_API_KEY;
  if (!apiKey) return null;

  try {
    const results: Partial<EnrichmentResult> = {};

    // Person enrichment via email
    if (lead.email) {
      const r = await fetch(`https://person.clearbit.com/v2/people/find?email=${encodeURIComponent(lead.email)}`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
      });

      if (r.ok) {
        const person = await r.json();
        if (person.name) {
          if (person.name.givenName && !lead.firstName) results.firstName = person.name.givenName;
          if (person.name.familyName && !lead.lastName) results.lastName = person.name.familyName;
        }
        if (person.email && !lead.email) results.email = person.email;
        if (person.location && !lead.location) results.location = person.location;
        if (person.title && !lead.title) results.title = person.title;
        if (person.seniority && !lead.seniority) results.seniority = person.seniority;
        if (person.department && !lead.department) results.department = person.department;
        if (person.linkedin?.handle && !lead.linkedinUrl) results.linkedinUrl = `https://linkedin.com/in/${person.linkedin.handle}`;
        if (person.twitter?.handle) results.socialProfiles = { twitter: `https://twitter.com/${person.twitter.handle}` };
        if (person.github?.handle) results.socialProfiles = { ...results.socialProfiles, github: `https://github.com/${person.github.handle}` };
        if (person.bio) results.intentSignals = [`Bio: ${person.bio}`];
      }
    }

    // Company enrichment via domain
    if (lead.email) {
      const domain = lead.email.split("@")[1];
      if (domain) {
        const r = await fetch(`https://company.clearbit.com/v2/companies/find?domain=${encodeURIComponent(domain)}`, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (r.ok) {
          const company = await r.json();
          if (company.name && !lead.company) results.company = company.name;
          if (company.legalName && !lead.company) results.company = company.legalName;
          if (company.description && !results.intentSignals) results.intentSignals = [`Description: ${company.description}`];
          if (company.sector && !lead.industry) results.industry = company.sector;
          if (company.metrics?.employees && !lead.companySize) results.companySize = String(company.metrics.employees);
          if (company.metrics?.annualRevenue && !lead.revenue) results.revenue = String(company.metrics.annualRevenue);
          if (company.location) {
            const loc = company.location;
            if (loc.city && !lead.location) results.location = loc.city;
            if (loc.state && !lead.location) results.location = (results.location || "") + (results.location ? ", " : "") + loc.state;
            if (loc.country && !lead.country) results.country = loc.country;
          }
          if (company.tech?.length) {
            const techNames = company.tech.filter(Boolean);
            if (techNames.length) results.technologies = techNames;
          }
          if (company.domain) results.socialProfiles = { ...results.socialProfiles, website: `https://${company.domain}` };
        }
      }
    }

    return Object.keys(results).length > 0 ? results : null;
  } catch (error) {
    console.warn("Clearbit enrichment failed:", error);
    return null;
  }
}

/**
 * Hunter.io - email verification and finding.
 * Docs: https://hunter.io/api-documentation
 */
export async function enrichWithHunter(
  lead: any,
  _fields: string[],
): Promise<Partial<EnrichmentResult> | null> {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;

  try {
    const results: Partial<EnrichmentResult> = {};

    // Email verification
    if (lead.email) {
      const r = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(lead.email)}&api_key=${apiKey}`);
      if (r.ok) {
        const data = await r.json();
        if (data.data?.status === "valid") {
          if (data.data.email && !lead.email) results.email = data.data.email;
        }
      }
    }

    // Email finder (by domain + name)
    if (lead.firstName && lead.lastName && lead.company) {
      const domain = lead.email?.split("@")[1];
      if (domain) {
        const params = new URLSearchParams({
          domain,
          first_name: lead.firstName,
          last_name: lead.lastName,
          api_key: apiKey,
        });
        const r = await fetch(`https://api.hunter.io/v2/email-finder?${params}`);
        if (r.ok) {
          const data = await r.json();
          if (data.data?.email && !lead.email) results.email = data.data.email;
          if (data.data?.confidence && data.data.confidence > 80) {
            results.intentSignals = [`Hunter confidence: ${data.data.confidence}%`];
          }
        }
      }
    }

    // Domain search - find all emails for a company
    if (lead.email) {
      const domain = lead.email.split("@")[1];
      if (domain) {
        const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}`);
        if (r.ok) {
          const data = await r.json();
          if (data.data?.emails?.length) {
            const emails = data.data.emails.map((e: any) => e.value).filter(Boolean);
            if (emails.length) {
              if (!lead.email && emails[0]) results.email = emails[0];
              results.intentSignals = [`Found ${emails.length} emails at domain`];
            }
          }
        }
      }
    }

    return Object.keys(results).length > 0 ? results : null;
  } catch (error) {
    console.warn("Hunter enrichment failed:", error);
    return null;
  }
}

/**
 * LinkedIn enrichment - profile data.
 * Note: LinkedIn API requires OAuth and is more complex. This is a placeholder
 * for when proper OAuth is configured.
 */
export async function enrichWithLinkedIn(
  lead: any,
  _fields: string[],
): Promise<Partial<EnrichmentResult> | null> {
  // LinkedIn requires OAuth 2.0 and is more complex.
  // For now, return null. When implemented, it would use:
  // - LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET for OAuth
  // - /v2/me for profile data
  // - /v2/emailAddress for email
  console.warn("LinkedIn enrichment not yet implemented - requires OAuth setup");
  return null;
}

/**
 * Clearbit Company enrichment - company data by domain.
 */
export async function enrichWithClearbitCompany(
  lead: any,
  _fields: string[],
): Promise<Partial<EnrichmentResult> | null> {
  const apiKey = process.env.CLEARBIT_API_KEY;
  if (!apiKey) return null;

  try {
    // Try to get domain from email or company name
    const domain = lead.email?.split("@")[1];
    if (!domain && lead.company) {
      // Could use Clearbit's name-to-domain endpoint, but for now
      // we'll skip if no email domain
      return null;
    }
    if (!domain) return null;

    const r = await fetch(`https://company.clearbit.com/v2/companies/find?domain=${encodeURIComponent(domain)}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!r.ok) return null;
    const company = await r.json();

    const results: Partial<EnrichmentResult> = {};
    if (company.name) results.company = company.name;
    if (company.legalName) results.company = company.legalName;
    if (company.description) results.intentSignals = [`Description: ${company.description}`];
    if (company.sector) results.industry = company.sector;
    if (company.metrics?.employees) results.companySize = String(company.metrics.employees);
    if (company.metrics?.annualRevenue) results.revenue = String(company.metrics.annualRevenue);
    if (company.location) {
      const loc = company.location;
      if (loc.city) results.location = loc.city;
      if (loc.state) results.location = (results.location || "") + (results.location ? ", " : "") + loc.state;
      if (loc.country) results.country = loc.country;
    }
    if (company.tech?.length) {
      const techNames = company.tech.filter(Boolean);
      if (techNames.length) results.technologies = techNames;
    }
    if (company.domain) results.socialProfiles = { website: `https://${company.domain}` };

    return Object.keys(results).length > 0 ? results : null;
  } catch (error) {
    console.warn("Clearbit Company enrichment failed:", error);
    return null;
  }
}

/**
 * Apollo Company enrichment - company data by domain/name.
 */
export async function enrichWithApolloCompany(
  lead: any,
  _fields: string[],
): Promise<Partial<EnrichmentResult> | null> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  try {
    // Search by domain if available
    const domain = lead.email?.split("@")[1];
    if (!domain && lead.company) {
      // Could search by name, but for now need domain
      return null;
    }
    if (!domain) return null;

    const r = await fetch(`https://api.apollo.io/api/v1/organizations/search?domain=${encodeURIComponent(domain)}`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    if (!r.ok) return null;
    const data = await r.json();
    const org = data.organizations?.[0];
    if (!org) return null;

    const results: Partial<EnrichmentResult> = {};
    if (org.name) results.company = org.name;
    if (org.industry) results.industry = org.industry;
    if (org.estimated_num_employees) results.companySize = String(org.estimated_num_employees);
    if (org.annual_revenue) results.revenue = String(org.annual_revenue);
    if (org.technologies?.length) {
      const techNames = org.technologies.map((t: any) => t.name).filter(Boolean);
      if (techNames.length) results.technologies = techNames;
    }
    if (org.linkedin_url) results.socialProfiles = { linkedin: org.linkedin_url };

    return Object.keys(results).length > 0 ? results : null;
  } catch (error) {
    console.warn("Apollo Company enrichment failed:", error);
    return null;
  }
}

/**
 * Map of provider names to their implementation functions.
 * This is the dispatch table that `enrichWithProvider` uses.
 */
export const PROVIDER_IMPLEMENTATIONS: Record<string, (lead: any, fields: string[]) => Promise<Partial<EnrichmentResult> | null>> = {
  apollo: enrichWithApollo,
  clearbit: enrichWithClearbit,
  hunter: enrichWithHunter,
  linkedin: enrichWithLinkedIn,
  clearbit_company: enrichWithClearbitCompany,
  apollo_company: enrichWithApolloCompany,
  derive: async (lead, _fields) => {
    const { seniorityFromTitle } = await import("./seniority");
    const seniority = seniorityFromTitle(lead.title);
    return seniority === null ? {} : { seniority };
  },
};