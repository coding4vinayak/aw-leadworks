import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Pricing — LeadWorks",
  description: "LeadWorks pricing: $49 per month.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
        <p className="mt-2 text-gray-600">Flat monthly price — seats, sources, and exports included. Your CRM bill is complicated enough.</p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-600">Monthly</p>
            <p className="mt-2 text-4xl font-bold">$49</p>
            <p className="mt-1 text-sm text-gray-600">per month</p>
            <a href="/dashboard?workspace=demo" className="mt-6 block rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700 transition">Start now</a>
          </div>
          <div className="rounded-2xl border-2 border-blue-600 p-6 bg-blue-50">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Annual — 2 months free</p>
            <p className="mt-2 text-4xl font-bold">$490</p>
            <p className="mt-1 text-sm text-gray-600">per month, billed yearly</p>
            <a href="mailto:support@abetworks.in?subject=LeadWorks%20annual%20plan" className="mt-6 block rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700 transition">Go annual</a>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-600">Enterprise</p>
            <p className="mt-2 text-4xl font-bold">Custom</p>
            <p className="mt-1 text-sm text-gray-600">SSO, audit exports, SLA, onboarding</p>
            <a href="mailto:support@abetworks.in?subject=LeadWorks%20enterprise" className="mt-6 block rounded-lg border border-blue-600 px-4 py-2 text-center text-sm font-semibold text-blue-600 hover:bg-blue-50 transition">Talk to us</a>
          </div>
        </div>
        <h2 className="mt-12 text-xl font-bold">Questions</h2>
        <div className="mt-4 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">Yes — the live demo workspace has a real source, rule, and export profile. No card required.</p></div>
          <div><p className="font-semibold text-gray-900">Where does the data come from?</p><p className="mt-1 text-gray-600">Your sources: scrapers you configure, APIs you connect, CSVs you upload. We never resell third-party lists.</p></div>
          <div><p className="font-semibold text-gray-900">Can I cancel anytime?</p><p className="mt-1 text-gray-600">Yes. Plans are month-to-month; service runs to the end of your billing period.</p></div>
          <div><p className="font-semibold text-gray-900">Do you offer annual billing?</p><p className="mt-1 text-gray-600">Yes — $490 per year, two months free, one invoice.</p></div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
