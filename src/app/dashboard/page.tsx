import Link from "next/link";
import { prisma } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard-shell";
import { resolveWorkspace } from "@/lib/resolve-workspace";
import { signOut } from "@/app/auth-actions";
import { switchWorkspaceAction } from "@/app/member-actions";
import { createFirstKey } from "@/app/key-actions";
import { ApiKeyOnboarding } from "@/components/api-key-onboarding";
import { AiPanel, type AiField } from "@/components/ai-panel";

export const dynamic = "force-dynamic";

function Badge({ tone, children }: { tone: "green" | "blue" | "red" | "gray"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Card({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function statusTone(status: string): "green" | "blue" | "red" | "gray" {
  if (status === "COMPLETED" || status === "QUALIFIED" || status === "ACTIVE") return "green";
  if (status === "RUNNING" || status === "PENDING" || status === "ENRICHED") return "blue";
  if (status === "FAILED" || status === "REJECTED") return "red";
  return "gray";
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const { workspace: requestedSlug } = await searchParams;
  // One policy, shared: the demo stays public, a customer's own workspace needs
  // their session, and naming anyone else's slug is refused rather than served.
  const resolved = await resolveWorkspace(requestedSlug);
  if (!resolved.workspace) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-gray-600">
            That workspace needs an account. Sign in to open yours.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }
  const workspace = resolved.workspace;
  const session = resolved.session;

  const leads = session ? await prisma.lead.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, firstName: true, lastName: true, company: true, email: true, score: true },
  }) : [];

  // The bar's workspace switcher needs the full list. Anonymous visitors get
  // none — the demo badge already says what they are looking at.
  const myWorkspaces = session
    ? await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const liveKeyCount = session
    ? await prisma.apiKey.count({ where: { workspaceId: workspace.id, revokedAt: null } })
    : null;

  const [leadCount, qualifiedCount, sources, jobs, topLeads] = await Promise.all([
    prisma.lead.count({ where: { workspaceId: workspace.id } }),
    prisma.lead.count({ where: { workspaceId: workspace.id, status: "QUALIFIED" } }),
    prisma.source.findMany({ where: { workspaceId: workspace.id }, orderBy: { updatedAt: "desc" }, take: 10 }),
    prisma.job.findMany({
      where: { workspaceId: workspace.id },
      include: { source: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.lead.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { score: "desc" },
      take: 10,
      select: { id: true, email: true, firstName: true, lastName: true, company: true, title: true, score: true, status: true },
    }),
  ]);

  return (
    <DashboardShell
      product="LeadWorks"
      accent="text-orange-600"
      accentSoft="bg-orange-500"
      account={
        session
          ? {
              name: session.name,
              email: session.email,
              signOut,
              workspaces: myWorkspaces.map((m) => m.workspace),
              currentWorkspaceId: session.workspaceId,
              switchWorkspace: switchWorkspaceAction,
            }
          : null
      }
      workspace={workspace.name}
      title="Sourcing dashboard"
    >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card label="Leads" value={leadCount} />
          <Card label="Qualified" value={qualifiedCount} />
          <Card label="Sources" value={sources.length} sub={`${sources.filter((s) => s.isActive).length} active`} />
          <Card label="Jobs running" value={jobs.filter((j) => j.status === "RUNNING" || j.status === "PENDING").length} />
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Top leads by score</h2>
          {topLeads.length === 0 ? (
            <p className="text-sm text-gray-500">No leads yet. Run a source or <code>POST /api/leads</code>.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Company</th>
                    <th className="pb-2 pr-4 font-medium">Score</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {topLeads.map((l) => (
                    <tr key={l.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-medium text-gray-900">
                        {[l.firstName, l.lastName].filter(Boolean).join(" ") || l.email || "—"}
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{l.company ?? "—"}{l.title ? ` · ${l.title}` : ""}</td>
                      <td className="py-3 pr-4 text-gray-900 font-semibold">{l.score}</td>
                      <td className="py-3"><Badge tone={statusTone(l.status)}>{l.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Recent jobs</h2>
          {jobs.length === 0 ? (
            <p className="text-sm text-gray-500">No jobs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Type</th>
                    <th className="pb-2 pr-4 font-medium">Source</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-medium text-gray-900">{j.type}</td>
                      <td className="py-3 pr-4 text-gray-600">{j.source?.name ?? "—"}</td>
                      <td className="py-3 pr-4"><Badge tone={statusTone(j.status)}>{j.status}</Badge></td>
                      <td className="py-3 text-gray-600">{j.processedItems}/{j.totalItems || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      {session && (
        <div className="mt-6">
          <AiPanel
            config={{
              title: "Explain a lead score",
              blurb:
                "LeadWorks already computes the score from enrichment signals. This reads it back in plain English, and says what is missing that would raise it. The score itself is never changed.",
              endpoint: "/api/ai/explain-lead",
              method: "GET",
              entityLabel: "Lead",
              idField: "id",
              buttonLabel: "Explain this lead",
              emptyText: "No leads yet.",
              options: leads.map((l) => ({
                id: l.id,
                label: `${[l.firstName, l.lastName].filter(Boolean).join(" ") || l.email || l.id} — ${l.company ?? "no company"} (score ${l.score})`,
              })),
            }}
            fields={[
              { path: "score", title: "Deterministic score" },
              { path: "explanation.summary", title: "Why" },
              { path: "explanation.reasons", title: "Signals that drove it", list: true },
              { path: "explanation.gaps", title: "What is missing", list: true },
            ] satisfies AiField[]}
          />
        </div>
      )}

      {session && liveKeyCount === 0 && (
        // Only for a signed-in workspace with no usable key: a stranger on the
        // public demo has no account to attach a key to, and prompting them
        // would be an invitation to sign up mid-demo.
        <div className="mt-6">
          <ApiKeyOnboarding createKey={createFirstKey} />
        </div>
      )}
      </DashboardShell>
  );
}
