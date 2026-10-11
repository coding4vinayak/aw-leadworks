import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Terms of Service — LeadWorks",
  description: "LeadWorks terms of service.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm opacity-70">Last updated: September 2026 · LeadWorks by Abetworks</p>
        <div className="prose-sm mt-8 space-y-6 leading-relaxed">
          <section><h2 className="text-lg font-semibold">1. What LeadWorks is</h2>
          <p>LeadWorks is a lead sourcing and enrichment platform provided by Abetworks (&quot;we&quot;). By creating an account or using the service you agree to these terms.</p></section>
          <section><h2 className="text-lg font-semibold">2. Your account</h2>
          <p>You are responsible for activity under your credentials and for keeping API keys secret. Plaintext keys are shown once — if you lose one, mint a replacement and revoke the old one. Tell us at support@abetworks.in about any suspected breach.</p></section>
          <section><h2 className="text-lg font-semibold">3. Billing</h2>
          <p>Plans are month-to-month (annual options are yearly). Cancel anytime from your workspace; service runs to the end of the paid period. Fees are non-refundable except where the law requires otherwise.</p></section>
          <section><h2 className="text-lg font-semibold">4. Acceptable use</h2>
          <p>No spam, no scraping anyone else&apos;s data through our infrastructure, no unlawful content, no attempts to break rate limits, other tenants&apos; workspaces, or the service itself. We may suspend accounts that threaten deliverability, security, or other customers.</p></section>
          <section><h2 className="text-lg font-semibold">5. Your data</h2>
          <p>You own your workspace data — messages, contacts, documents, metrics, workflows. Export anytime. We process it only to run the service, never sell it, and never train shared models on it. Backups exist for disaster recovery, not for resale.</p></section>
          <section><h2 className="text-lg font-semibold">6. Uptime and support</h2>
          <p>We target high availability and publish liveness at /api/health. Support tiers and response times are on the support page. Scheduled maintenance is announced in the changelog.</p></section>
          <section><h2 className="text-lg font-semibold">7. Liability</h2>
          <p>The service is provided &quot;as is&quot;. To the maximum extent permitted by law, Abetworks is not liable for indirect or consequential damages. Direct liability is capped at the fees you paid in the preceding 12 months.</p></section>
          <section><h2 className="text-lg font-semibold">8. Changes</h2>
          <p>We may update these terms with 30 days&apos; notice in the changelog. Continued use after the effective date is acceptance. Questions: support@abetworks.in.</p></section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
