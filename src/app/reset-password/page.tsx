import type { Metadata } from "next";
import Link from "next/link";
import { TokenRedeemForm } from "@/components/auth-form";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Choose a new password — LeadWorks",
};

// Reads a token from the query string, so it can never be prerendered.
export const dynamic = "force-dynamic";

/**
 * Same POST-only rule as the verification link: a GET would let a previewer burn the
 * token before the reader arrives. Redeeming also destroys every existing session
 * for that account, so a password reset actually evicts whoever prompted it.
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
        <p className="mt-2 text-sm text-gray-600">Choose a new password. This signs out every other session, which is the point of resetting.</p>
        <div className="mt-8">
          {token ? (
            <TokenRedeemForm token={token} label="Set new password" accent="text-orange-600" action="reset" />
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-[13px] leading-relaxed text-gray-800">
              <p>This link is missing its token.</p>
              <Link href="/forgot-password" className="mt-3 inline-block underline underline-offset-2">
                Request a new link
              </Link>
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
