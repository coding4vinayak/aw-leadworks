import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Support — LeadWorks",
  description: "Get help with LeadWorks: contact, SLAs, status, and quick answers.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Support</h1>
        <p className="mt-2 text-gray-600">Real humans, business hours IST–EST overlap. For security issues write <a className="underline" href="mailto:security@abetworks.in">security@abetworks.in</a> — it pages someone.</p>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div><h2 className="text-lg font-semibold">Contact</h2>
            <p className="mt-2 text-gray-600">Email <a className="underline" href="mailto:support@abetworks.in">support@abetworks.in</a> with your workspace slug. Standard: first reply within 1 business day. Team plans and above: 4 hours. Enterprise: shared Slack channel.</p></div>
          <div><h2 className="text-lg font-semibold">Status</h2>
            <p className="mt-2 text-gray-600">Liveness plus a database ping, no key required: <a className="underline" href="/api/health">/api/health</a>. Anything degraded lands in the <a className="underline" href="/changelog">changelog</a> with a timestamp.</p></div>
        </div>
        <h2 className="mt-10 text-xl font-bold">Before you write in</h2>
        <div className="mt-4 space-y-4">
          <div><p className="font-semibold text-gray-900">The demo workspace looks empty</p><p className="mt-1 text-gray-600">Seed it (<code>npm run db:seed</code> in the repo) or pass <code>?workspace=&lt;slug&gt;</code> to point at your own data.</p></div>
          <div><p className="font-semibold text-gray-900">API returns 401</p><p className="mt-1 text-gray-600">Keys are shown once at mint time. Check the prefix, re-mint if lost, and confirm the key carries the scope the endpoint needs.</p></div>
          <div><p className="font-semibold text-gray-900">API returns 429</p><p className="mt-1 text-gray-600">You hit the per-minute quota. Back off per the <code>retry-after</code> header, or ask us to raise the ceiling.</p></div>
          <div><p className="font-semibold text-gray-900">Something looks wrong in the data</p><p className="mt-1 text-gray-600">Send the workspace slug, the request ID or timestamp, and what you expected. Traces and step logs make these fast to resolve.</p></div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
