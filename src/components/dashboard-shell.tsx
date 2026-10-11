import Link from "next/link";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

/**
 * Shared dashboard chrome for the Abetworks apps.
 *
 * Why this exists: every dashboard was an indigo-600 clone, so logging into
 * three different products felt like the same app. The parent brand and the
 * product's own accent are stated once here instead of being re-spelled as
 * raw utility classes in each page.
 */
export function DashboardShell({
  product,
  accent,
  accentSoft,
  workspace,
  title,
  eyebrow,
  account,
  children,
}: {
  product: string;
  accent: string;
  accentSoft: string;
  workspace?: string;
  title: string;
  eyebrow?: string;
  /**
   * Who is signed in. Left off, the bar shows a "Sign in" link, which is what
   * the public demo renders; set, it shows the account and a sign-out form.
   * The shell cannot read the session itself — it is a server component and
   * would force every caller to be one — so the page passes it in.
   */
  account?: {
    name: string | null;
    email: string;
    signOut: () => Promise<void>;
    /** Every workspace this account can open, so the bar can switch between them. */
    workspaces?: { id: string; name: string; slug: string }[];
    currentWorkspaceId?: string;
    /** Moves the session into the named workspace. */
    switchWorkspace?: (formData: FormData) => Promise<void>;
  } | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Parent-brand bar: Abetworks owns the product, not the other way round. */}
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-gray-400">Abetworks</span>
            <span className="text-gray-300" aria-hidden="true">
              /
            </span>
            <span className={`font-semibold ${accent}`}>{product}</span>
            {workspace && (
              <>
                <span className="text-gray-300" aria-hidden="true">
                  ·
                </span>
                <span className="text-gray-500 truncate max-w-[24ch]">{workspace}</span>
              </>
            )}
          </div>
          <nav className="flex items-center gap-4 text-xs">
            <Link href="/pricing" className="text-gray-500 hover:text-gray-900">
              Pricing
            </Link>
            <Link href="/support" className="text-gray-500 hover:text-gray-900">
              Support
            </Link>
            <Link href="/api/health" className="text-gray-500 hover:text-gray-900">
              Status
            </Link>
            {account ? (
              <div className="flex items-center gap-2 border-l border-gray-200 pl-4">
                <Link href="/members" className="text-gray-500 hover:text-gray-900">
                  Team
                </Link>
                {account.switchWorkspace && (
                  <WorkspaceSwitcher
                    workspaces={account.workspaces ?? []}
                    currentWorkspaceId={account.currentWorkspaceId ?? ""}
                    switchWorkspace={account.switchWorkspace}
                  />
                )}
                <span className="max-w-[18ch] truncate text-gray-500" title={account.email}>
                  {account.name || account.email}
                </span>
                <form action={account.signOut}>
                  <button type="submit" className="text-gray-500 hover:text-gray-900">
                    Sign out
                  </button>
                </form>
              </div>
            ) : (
              <>
                <span className="text-gray-300" aria-hidden="true">
                  ·
                </span>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                  Demo data
                </span>
                <Link href="/login" className="font-semibold text-gray-900 hover:underline">
                  Sign in
                </Link>
              </>
            )}
          </nav>
        </div>
      </div>

      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            {eyebrow && (
              <p
                className={`text-xs font-semibold uppercase tracking-wide ${accent}`}
              >
                {eyebrow}
              </p>
            )}
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          </div>
        </div>
        {/* A hairline in the product colour: the cheapest way to make six
            dashboards feel like six products instead of one template. */}
        <div
          className={`h-0.5 w-16 rounded-full mb-8 ${accentSoft}`}
          aria-hidden="true"
        />
        {children}
      </main>

      <footer className="max-w-6xl mx-auto px-6 pb-8 text-xs text-gray-400">
        {product} by Abetworks ·{" "}
        <Link href="/terms" className="hover:underline">
          Terms
        </Link>{" "}
        ·{" "}
        <Link href="/privacy" className="hover:underline">
          Privacy
        </Link>
      </footer>
    </div>
  );
}
