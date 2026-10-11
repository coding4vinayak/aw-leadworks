import { chromium, Browser, Page } from "playwright";
import { prisma } from "./db";
import { queues, enqueue } from "./queue";

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
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
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
      await prisma.lead.update({
        where: { id: existing.id },
        data,
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

export async function runScheduledScrapers(): Promise<void> {
  const now = new Date();
  const sources = await prisma.source.findMany({
    where: { isActive: true, schedule: { not: null } },
    include: { workspace: true },
  });

  for (const source of sources) {
    if (!source.schedule) continue;
    // In production, use a proper cron parser like croner
    // This is a simplified check - run if schedule contains current hour
    const cronParts = source.schedule.split(" ");
    const currentHour = now.getHours();
    if (cronParts[1] !== "*" && parseInt(cronParts[1]) !== currentHour) continue;

    const job = await prisma.job.create({
      data: {
        workspaceId: source.workspaceId,
        sourceId: source.id,
        type: "SCRAPE",
        status: "PENDING",
        config: { url: source.config as any, selectors: {} },
      },
    });

    await enqueue(queues.scrape, "run-scrape", { jobId: job.id });
  }
}