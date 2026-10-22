import { chromium, Browser, Page } from "playwright";
import { existsSync } from "node:fs";
import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import { classifyLaunchFailure, scrapeCapability, type Capability } from "./scrape-capability";
import { rowAfterWrite, scoredWriteData } from "./lead-score";

export interface ScrapeConfig {
  url: string;
  selectors: Record<string, string>;
  pagination?: {
    type: "scroll" | "next_button" | "url_param";
    selector?: string;
    maxPages?: number;
    paramName?: string;
  };
  waitFor?: string;
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string }>;
}

export interface ScrapedLead {
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
  source?: string;
}

/** What this instance would launch, and whether it is there. Kept out of the pure module. */
export function readBrowserProbe(): Capability {
  let executablePath: string | null = null;
  try {
    executablePath = chromium.executablePath();
  } catch {
    executablePath = null;
  }
  return scrapeCapability({ executablePath, present: executablePath !== null && existsSync(executablePath) });
}

export async function runScrapeJob(jobId: string): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (!job.sourceId) throw new Error(`Job ${jobId} has no source`);

  await prisma.job.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date() } });

  const config = job.config as unknown as ScrapeConfig;
  let browser: Browser | null = null;
  let totalFound = 0;
  let totalSaved = 0;
  let errors = 0;

  try {
    // Two questions get answered before this process opens a wire. The policy is asked
    // first, and not because it costs more: `config.url` is a caller-named address this
    // server is about to connect to, and a refusal that depends on which box the code is
    // sitting on must not be allowed to swallow a refusal that does not. #39 measured
    // `file:///etc/passwd` and `http://169.254.169.254/latest/meta-data/` stored by
    // `POST /api/sources` with a 201 and run with the identical failure a public URL got,
    // which is the signature of a check that never ran — and this box has no browser, so
    // had the capability been asked first every one of those runs would have reported
    // hardware and the guard's verdict would have been unobservable on the instance that
    // needed to prove it. The capability second, because on an instance with no browser
    // nothing else in this function can happen and the launch's own failure is a
    // five-line banner that would otherwise land in `Source.lastRunError`.
    // `assertAllowedTarget` is the same call the webhook delivery makes and the source
    // doors make, so a scrape cannot be pointed somewhere a webhook could not be pointed.
    await assertAllowedTarget(config.url, "config.url");
    const capability = readBrowserProbe();
    if (!capability.runnable) throw new Error(capability.reason);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });

    if (config.cookies) {
      await context.addCookies(config.cookies);
    }

    const page = await context.newPage();
    if (config.headers) {
      await page.setExtraHTTPHeaders(config.headers);
    }

    let currentPage = 1;
    const maxPages = config.pagination?.maxPages || 1;

    while (currentPage <= maxPages) {
      const pageUrl = buildPageUrl(config.url, config.pagination, currentPage);
      // Pagination is built out of the caller's own URL, so the page-2 answer is a second
      // caller-named address and gets the second ask. This is the line the navigation
      // actually hands to the browser, and the egress census reads a policy call sitting
      // in the same block above it.
      await assertAllowedTarget(pageUrl, "config.url");
      await page.goto(pageUrl, { waitUntil: "networkidle" });

      if (config.waitFor) {
        await page.waitForSelector(config.waitFor, { timeout: 30000 });
      }

      const leads = await extractLeads(page, config.selectors);
      totalFound += leads.length;

      for (const lead of leads) {
        const saved = await saveLead(job.workspaceId, job.sourceId, lead);
        if (saved) totalSaved++;
      }

      await prisma.job.update({
        where: { id: jobId },
        data: { progress: Math.round((currentPage / maxPages) * 100), processedItems: totalSaved, failedItems: errors },
      });

      if (currentPage >= maxPages) break;

      const hasNext = await navigateToNextPage(page, config.pagination);
      if (!hasNext) break;

      currentPage++;
      await page.waitForTimeout(2000); // Rate limiting
    }

    await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED", completedAt: new Date(), progress: 100, processedItems: totalSaved, failedItems: errors },
    });

    await prisma.source.update({
      where: { id: job.sourceId },
      data: { lastRunAt: new Date(), lastRunStatus: "SUCCESS", totalLeadsFound: { increment: totalSaved } },
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : "Unknown error";
    // A missing browser gets one sentence rather than Playwright's banner, because this
    // string is what `Source.lastRunError` will hold and what an operator reads. Anything
    // else keeps its own words: a scrape error tidied into a capability sentence would be
    // a different lie.
    const errorMessage = classifyLaunchFailure(raw) ?? raw;
    errors++;
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "FAILED", completedAt: new Date(), error: errorMessage, failedItems: errors },
    });
    await prisma.source.update({
      where: { id: job.sourceId },
      data: { lastRunAt: new Date(), lastRunStatus: "FAILED", lastRunError: errorMessage },
    });
  } finally {
    if (browser) await browser.close();
  }
}

function buildPageUrl(baseUrl: string, pagination?: ScrapeConfig["pagination"], page: number = 1): string {
  if (!pagination) return baseUrl;

  switch (pagination.type) {
    case "url_param":
      const url = new URL(baseUrl);
      url.searchParams.set(pagination.paramName || "page", page.toString());
      return url.toString();
    case "next_button":
    case "scroll":
    default:
      return baseUrl;
  }
}

async function extractLeads(page: Page, selectors: Record<string, string>): Promise<ScrapedLead[]> {
  return await page.evaluate((sel) => {
    const items = document.querySelectorAll(sel.container);
    return Array.from(items).map((item) => {
      const result: Record<string, string | undefined> = {};
      for (const [field, selector] of Object.entries(sel)) {
        if (field === "container") continue;
        const el = item.querySelector(selector);
        result[field] = el?.textContent?.trim() || el?.getAttribute("href") || undefined;
      }
      return result;
    });
  }, selectors);
}

async function saveLead(workspaceId: string, sourceId: string | undefined, lead: ScrapedLead): Promise<boolean> {
  if (!lead.email && !lead.phone && !lead.linkedinUrl) return false;

  try {
    // `source` is the scraper's free-text origin label, not the Source
    // relation — it maps to sourceRef. Destructure it out so the spread
    // below cannot collide with the relation field.
    const { source, ...leadData } = lead;
    const data = {
      ...leadData,
      ...(source != null ? { sourceRef: source } : {}),
      ...(sourceId != null ? { sourceId } : {}),
    };
    const existing = lead.email
      ? await prisma.lead.findUnique({ where: { workspaceId_email: { workspaceId, email: lead.email } } })
      : null;

    if (existing) {
      // A scrape that changes the row's signals changes its score, in the same
      // write. `rowAfterWrite` is the row as this update leaves it, because Prisma
      // ignores the `undefined`s a scrape's missing fields arrive as.
      await prisma.lead.update({
        where: { id: existing.id },
        data: { ...data, ...scoredWriteData(rowAfterWrite(existing, data)) },
      });
      return true;
    }

    await prisma.lead.create({
      data: {
        workspaceId,
        ...data,
        technologies: lead.technologies ?? [],
        intentSignals: lead.intentSignals ?? [],
        tags: [],
        status: "NEW",
        ...scoredWriteData(data),
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function navigateToNextPage(page: Page, pagination?: ScrapeConfig["pagination"]): Promise<boolean> {
  if (!pagination) return false;

  if (pagination.type === "next_button" && pagination.selector) {
    const nextBtn = await page.$(pagination.selector);
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForLoadState("networkidle");
      return true;
    }
  }
  return false;
}
