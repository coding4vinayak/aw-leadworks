import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "LeadWorks — Find the buyers who are already looking.",
  description: "Sources, scraping, enrichment, validation, and exports in one pipeline — every lead scored 0–100 with its provenance attached.",
};

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main>
        <section className="mx-auto max-w-4xl px-6 pb-16 pt-20 text-center">
          <p className="inline-block rounded-full bg-blue-50 text-blue-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            v1.0 · Now generally available
          </p>
          <h1 className="mt-6 text-5xl font-bold tracking-tight">LeadWorks</h1>
          <p className="mx-auto mt-4 max-w-2xl text-xl text-gray-600">Find the buyers who are already looking.</p>
          <p className="mx-auto mt-3 max-w-2xl text-gray-600">Sources, scraping, enrichment, validation, and exports in one pipeline — every lead scored 0–100 with its provenance attached.</p>
          <div className="mt-8 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              Pricing · $49 per month
            </Link>
          </div>
        </section>
        <section id="features" className="mx-auto max-w-6xl px-6 py-12">
          <h2 className="text-center text-2xl font-bold">Why teams pick LeadWorks</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Four ways leads get in</h3>
            <p className="mt-2 text-sm text-gray-600">Web scrapers, APIs, CSV uploads, and manual entry all feed the same pipeline.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Enrichment with receipts</h3>
            <p className="mt-2 text-sm text-gray-600">Every enrichment writes a log entry: what was added, from where, and when.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Quality scores that mean it</h3>
            <p className="mt-2 text-sm text-gray-600">0–100 scores plus validation trails, so sales works the top and ignores the rest.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Dedupe that merges, not deletes</h3>
            <p className="mt-2 text-sm text-gray-600">Email, phone, LinkedIn, or fuzzy-name matches merge into the most complete record — nothing silently dropped.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Exports in your format</h3>
            <p className="mt-2 text-sm text-gray-600">CSV, JSON, XLSX, or PDF with scheduled profiles for weekly drops.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Handoff to LeadGenius</h3>
            <p className="mt-2 text-sm text-gray-600">Verified leads flow straight into outreach with provenance intact — tested end to end.</p>
          </div>
          </div>
        </section>
        <section className="border-y border-gray-200 bg-gray-50">
          <div className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <h2 className="text-2xl font-bold">Live in three steps</h2>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</span>
            <div><p className="font-bold text-gray-900">Add a source</p><p className="mt-1 text-sm text-gray-600">Try the LinkedIn Scraper in the demo workspace, or connect your own scraper, API, or CSV.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</span>
            <div><p className="font-bold text-gray-900">Run and enrich</p><p className="mt-1 text-sm text-gray-600">Jobs scrape, enrich, validate, and score. Watch the enrichment log on any lead.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">3</span>
            <div><p className="font-bold text-gray-900">Export or hand off</p><p className="mt-1 text-sm text-gray-600">Download what you need or push hot leads straight into a LeadGenius campaign.</p></div>
          </div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 py-12">
          <h2 className="text-2xl font-bold">Questions, answered</h2>
          <div className="mt-6 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">Yes — the live demo workspace has a real source, rule, and export profile. No card required.</p></div>
          <div><p className="font-semibold text-gray-900">Where does the data come from?</p><p className="mt-1 text-gray-600">Your sources: scrapers you configure, APIs you connect, CSVs you upload. We never resell third-party lists.</p></div>
          <div><p className="font-semibold text-gray-900">Can I cancel anytime?</p><p className="mt-1 text-gray-600">Yes. Plans are month-to-month; service runs to the end of your billing period.</p></div>
          <div><p className="font-semibold text-gray-900">Do you offer annual billing?</p><p className="mt-1 text-gray-600">Yes — $490 per year, two months free, one invoice.</p></div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 pb-16 text-center">
          <h2 className="text-2xl font-bold">Try the live demo — no card, no call.</h2>
          <div className="mt-6 flex justify-center gap-4">
            <a href="/dashboard?workspace=demo" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Open live demo
            </a>
            <Link href="/pricing" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              See pricing
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
