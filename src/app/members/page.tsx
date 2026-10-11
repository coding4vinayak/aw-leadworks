import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";
import { canEditRole, canManageRoles } from "@/lib/roles";
import { listPendingInvites } from "@/lib/invites";
import { InviteForm } from "@/components/invite-form";
import { MemberRole } from "@/components/member-role";
import { PendingInvites } from "@/components/pending-invites";

const PRODUCT = "LeadWorks";
const ACCENT = "text-orange-600";

export const metadata = { title: `Team — ${PRODUCT}` };
export const dynamic = "force-dynamic";

/** Owner first, then admin, then member. Sorting by name buries the owner. */
const RANK: Record<string, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };

const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" };

function stamp(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Relative, because the question a sender asks is "is this still usable". */
function expiresIn(expiresAt: Date): string {
  const hours = Math.floor((expiresAt.getTime() - Date.now()) / 3_600_000);
  if (hours < 1) return "expires within the hour";
  if (hours < 24) return "expires today";
  const days = Math.floor(hours / 24);
  return days === 1 ? "expires tomorrow" : `expires in ${days} days`;
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-gray-200 py-8 first:border-t-0 first:pt-0">
      <h2 className="text-[15px] font-semibold tracking-tight text-gray-900">{title}</h2>
      {note && <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-gray-600">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The roles this viewer may set on a seat that currently has `target`.
 *
 * canEditRole decides whether the seat is editable at all; canGrant's rules are
 * the ones that decide which roles may be handed out, so a dropdown cannot
 * sidestep them. This only chooses what to offer — the action re-checks both.
 */
function roleOptionsFor(actor: string, target: string): Array<{ value: string; label: string }> {
  if (!canEditRole(actor, target)) return [];
  const options: Array<{ value: string; label: string }> = [];
  if (target !== "MEMBER") options.push({ value: "MEMBER", label: "Member" });
  if (actor === "OWNER" && target !== "ADMIN") options.push({ value: "ADMIN", label: "Admin" });
  options.push({ value: "REMOVE", label: "No access" });
  return options;
}

export default async function MembersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [memberships, invites] = await Promise.all([
    prisma.membership.findMany({
      where: { workspaceId: session.workspaceId },
      include: { user: { select: { email: true, name: true } } },
    }),
    listPendingInvites(session.workspaceId),
  ]);

  const members = memberships.sort(
    (a, b) => (RANK[a.role] ?? 9) - (RANK[b.role] ?? 9) || a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const isManager = canManageRoles(session.role);
  const roles =
    session.role === "OWNER"
      ? [
          { value: "MEMBER", label: "Member" },
          { value: "ADMIN", label: "Admin" },
        ]
      : [{ value: "MEMBER", label: "Member" }];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className={`mt-1 text-2xl font-bold tracking-tight ${ACCENT}`}>{PRODUCT}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-gray-600">
          Everyone who can open <strong>{session.workspaceName}</strong>. Seats are invited by an
          owner or an admin, and an invitation names one address and works once, so it cannot be
          forwarded to whoever happens to click it first.
        </p>

        <div className="mt-8">
          <Section
            title="People with access"
            note={
              isManager
                ? "Owners and admins invite people and manage keys. Members work, and cannot see or revoke credentials."
                : "You can work. Invitations and keys are managed by an owner or admin."
            }
          >
            <ul className="space-y-1.5">
              {members.map((membership) => {
                const options = roleOptionsFor(session.role, membership.role);
                const email = membership.user.email;
                return (
                  <li key={membership.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
                    <span className="font-medium text-gray-900">
                      {membership.user.name || email}
                      {membership.userId === session.userId ? " (you)" : ""}
                    </span>
                    <span className="font-mono text-[11px] text-gray-500">{email}</span>
                    {options.length > 0 ? (
                      <MemberRole
                        membershipId={membership.id}
                        role={membership.role}
                        label={email}
                        options={options}
                      />
                    ) : (
                      <span className="ml-auto text-gray-500">{ROLE_LABEL[membership.role] ?? membership.role}</span>
                    )}
                    <span className="w-full text-[11px] text-gray-500 sm:w-auto">
                      joined {stamp(membership.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Section>

          {isManager && (
            <Section
              title="Invite someone"
              note="They sign up first if they have no account, then open the link. Nothing joins the workspace until they accept."
            >
              <InviteForm roles={roles} />
            </Section>
          )}

          {isManager && (
            <Section
              title="Outstanding invitations"
              note={invites.length === 0 ? undefined : "Revoking stops a link that has already been sent from working."}
            >
              <PendingInvites
                invites={invites.map((invite) => ({
                  id: invite.id,
                  email: invite.email,
                  role: ROLE_LABEL[invite.role] ?? invite.role,
                  expires: expiresIn(invite.expiresAt),
                }))}
              />
            </Section>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
