import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Privacy Policy — LeadWorks",
  description: "LeadWorks privacy policy.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm opacity-70">Last updated: September 2026 · LeadWorks by Abetworks</p>
        <div className="prose-sm mt-8 space-y-6 leading-relaxed">
          <section><h2 className="text-lg font-semibold">1. Data we collect</h2>
          <p>Account data (name, email, workspace), customer content you put in (messages, contacts, documents, events — depending on the product), and minimal operational logs (timestamps, error traces, API usage counters for billing and rate limits).</p></section>
          <section><h2 className="text-lg font-semibold">2. What we never do</h2>
          <p>We never sell personal data, never share workspace content with advertisers, and never train shared AI models on your content. Analytics are aggregate or per-workspace — never cross-customer.</p></section>
          <section><h2 className="text-lg font-semibold">3. Why we process data</h2>
          <p>To operate the service (the legal basis is the contract), to secure it (legitimate interest: abuse prevention, rate limiting), and to bill accurately. Support may access workspace data only when you ask for help with it.</p></section>
          <section><h2 className="text-lg font-semibold">4. Subprocessors and transfers</h2>
          <p>Hosting and any AI model providers you configure (you bring your own LLM key — prompts go to your provider, not ours). A current subprocessor list is available on request at support@abetworks.in.</p></section>
          <section><h2 className="text-lg font-semibold">5. Retention and deletion</h2>
          <p>Workspace content lives until you delete it. Delete your workspace and content is removed within 30 days (backups age out within 90). Export everything first from your dashboard.</p></section>
          <section><h2 className="text-lg font-semibold">6. Your rights</h2>
          <p>Access, correction, export, and deletion: email support@abetworks.in and we respond within 30 days. EU/UK users can also complain to their supervisory authority.</p></section>
          <section><h2 className="text-lg font-semibold">7. Cookies</h2>
          <p>Session cookie for sign-in, workspace preference, nothing for advertising, no third-party trackers on app pages.</p></section>
          <section><h2 className="text-lg font-semibold">8. Changes</h2>
          <p>Material changes get 30 days&apos; notice in the changelog. Questions: support@abetworks.in.</p></section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
