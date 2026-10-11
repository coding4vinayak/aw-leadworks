import Link from "next/link";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-[15px] font-bold tracking-tight text-gray-900">
          LeadWorks
        </Link>
        <div className="flex items-center gap-5">
          <Link href="/pricing" className="text-gray-600 hover:text-gray-900 text-sm">Pricing</Link>
          <Link href="/support" className="text-gray-600 hover:text-gray-900 text-sm">Support</Link>
          <Link href="/changelog" className="text-gray-600 hover:text-gray-900 text-sm">Changelog</Link>
          <Link href="/login" className="text-gray-600 hover:text-gray-900 text-sm">
            Sign in
          </Link>
          <Link href="/signup" className="rounded-lg text-white hover:opacity-90 px-4 py-2 text-sm font-semibold transition bg-orange-600">
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}

const COLS: [string, [string, string][]][] = [
  ["Product", [["Pricing", "/pricing"], ["Live demo", "/dashboard?workspace=demo"], ["Changelog", "/changelog"], ["Support", "/support"]]],
  ["Developers", [["API health", "/api/health"], ["Changelog", "/changelog"]]],
  ["Company", [["Terms", "/terms"], ["Privacy", "/privacy"], ["Contact", "mailto:support@abetworks.in"]]],
];

export function SiteFooter() {
  return (
    <footer className="border-t border-gray-200 bg-gray-50">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 sm:grid-cols-4">
        <div>
          <p className="text-[15px] font-bold text-gray-900">LeadWorks</p>
          <p className="text-gray-500 text-sm mt-2 max-w-xs">Find the buyers who are already looking.</p>
        </div>
        {COLS.map(([title, links]) => (
          <div key={title}>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
            <ul className="mt-3 space-y-2">
              {links.map(([label, href]) => (
                <li key={label}>
                  {href.startsWith("/") ? (
                    <Link href={href} className="text-gray-600 hover:text-gray-900 text-sm">{label}</Link>
                  ) : (
                    <a href={href} className="text-gray-600 hover:text-gray-900 text-sm">{label}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-200">
        <p className="mx-auto max-w-6xl px-6 py-4 text-gray-500 text-sm">© 2026 Abetworks · LeadWorks · All systems normal — see <a href="/api/health" className="underline">status</a>.</p>
      </div>
    </footer>
  );
}
