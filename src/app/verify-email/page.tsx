import type { Metadata } from "next";
import Link from "next/link";
import { TokenRedeemForm } from "@/components/auth-form";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Verify your email — LeadWorks",
};

// Reads a token from the query string, so it can never be prerendered.
export const dynamic = "force-dynamic";

/**
 * A GET that changes state is something a link prefetcher, a chat client's URL
 * expander or a corporate scanner can trigger before a human reads it — and the
 * token would be spent. So the page only reads the token; the button redeems it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto flex max-w-sm flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-orange-600">LeadWorks</h1>
        <p className="mt-2 text-sm text-gray-600">Confirm this address to finish setting up your workspace.</p>
        <div className="mt-8">
          {token ? (
            <TokenRedeemForm token={token} label="Confirm my email" accent="text-orange-600" action="verify" />
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-[13px] leading-relaxed text-gray-800">
              <p>This link is missing its token.</p>
              <Link href="/dashboard" className="mt-3 inline-block underline underline-offset-2">
                Go to your dashboard
              </Link>
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
