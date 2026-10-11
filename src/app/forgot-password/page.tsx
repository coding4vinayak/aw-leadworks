import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Reset your password — LeadWorks",
};

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  // Someone already signed in has nothing to reset, and sending them a reset
  // link would be a small way to lock themselves out of their own account.
  if (await getSession()) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto flex max-w-sm flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-orange-600">LeadWorks</h1>
        <p className="mt-2 text-sm text-gray-600">
          Enter your email and we will send a link to choose a new password.
        </p>
        <div className="mt-8">
          <AuthForm mode="forgot" accent="text-orange-600" />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
