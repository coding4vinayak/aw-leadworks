import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Changelog — LeadWorks",
  description: "What changed in LeadWorks, newest first.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-gray-600">Newest first. Breaking changes are marked <strong>BREAKING</strong> and get 30 days&apos; notice here before they ship.</p>
        <div className="mt-8 space-y-8 border-l-2 border-blue-600 pl-6">
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.0.1 — every lead&apos;s score is computed, and shows its work</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li><code>score</code> is now arithmetic the row can be walked through: one table of signals in <code>lib/lead-score.ts</code>, its terms stored beside the lead. Nothing about the column&apos;s 0–100 range changed.</li>
              <li>Behavior change: a score you set by <code>PATCH /api/leads/&#123;id&#125;</code> is kept as an override the computation honours, and it is stamped as one — send <code>score: null</code> to hand the number back to the row. A score also changes when the lead&apos;s signals do, which includes after enrichment, validation and a duplicate merge.</li>
              <li>Fixed: running a validation job used to subtract its failed checks from the score a second time on every run.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>General availability: Sources, scraping, enrichment, validation, and exports in one pipeline — every lead scored 0–100 with its provenance attached.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-gray-600">How we version: <code>major.minor.patch</code>. Minor adds features, patch fixes bugs, major is reserved for contract changes — and those are announced here first.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
