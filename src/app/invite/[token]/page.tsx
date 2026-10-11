import Link from "next/link";
import { prisma } from "@/lib/db";
import { SiteNav, SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";
import { hashInviteToken, inviteProblem } from "@/lib/invites";
import { signOut } from "@/app/auth-actions";
import { AcceptInvite } from "@/components/accept-invite";

const PRODUCT = "LeadWorks";
const ACCENT = "text-orange-600";

export const metadata = { title: `Accept an invitation — ${PRODUCT}` };
export const dynamic = "force-dynamic";

/**
 * An invitation link, from the outside.
 *
 * This page is reachable without an account, which is the whole point: the token
 * in the URL is the credential, and signing up afterwards is expected. Nothing
 * here trusts the link for more than a lookup — the decision about whether it
 * still grants anything is made again by acceptInvite when the button is pressed.
 */

/** base64url of 32 bytes is 43 characters. Anything else was not minted here, so
 *  it is answered without a database hit at all — crawlers and typos should not
 *  look like expired invitations. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <SiteNav />
      <div className="mx-auto flex w-full max-w-md flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Abetworks</p>
        <h1 className={`mt-1 text-2xl font-bold tracking-tight ${ACCENT}`}>{PRODUCT}</h1>
        <div className="mt-6 w-full rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
      </div>
      <SiteFooter />
    </div>
  );
}

const LINK_CLASS =
  "rounded-md border border-gray-300 px-3 py-2 text-[12px] text-gray-900 transition hover:bg-gray-50";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const invite = TOKEN_PATTERN.test(token)
    ? await prisma.invite.findUnique({
        where: { tokenHash: hashInviteToken(token) },
        select: {
          email: true,
          role: true,
          acceptedAt: true,
          expiresAt: true,
          workspace: { select: { name: true } },
        },
      })
    : null;

  const problem = inviteProblem(invite);
  const session = await getSession();

  if (!invite || problem) {
    return (
      <Card>
        <h2 className="text-[15px] font-semibold tracking-tight text-gray-900">This invitation won&rsquo;t open</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-gray-600">{problem ?? "That invitation does not exist."}</p>
        <p className="mt-3 text-[12px] leading-relaxed text-gray-500">
          Asking an owner or admin to send a fresh one is the fix. Invitations are single-use and
          expire, so an old link in a search box is expected to fail.
        </p>
        <div className="mt-5 flex gap-2">
          <Link href="/login" className={LINK_CLASS}>
            Sign in
          </Link>
          <Link href="/signup" className={LINK_CLASS}>
            Create an account
          </Link>
        </div>
      </Card>
    );
  }

  const roleLabel = invite.role === "ADMIN" ? "an admin" : "a member";

  if (!session) {
    return (
      <Card>
        <h2 className="text-[15px] font-semibold tracking-tight text-gray-900">Join {invite.workspace.name}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-gray-600">
          You have been invited as {roleLabel}. {PRODUCT} has not emailed you — someone copied this
          link to you, which is the part of the process that is still manual.
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-gray-500">
          Create an account with <span className="font-mono text-gray-900">{invite.email}</span> or
          sign in if you already have one, then open this link again. The invitation is still live
          while you do that, and it names that address, so an account with any other one cannot use
          it.
        </p>
        <div className="mt-5 flex gap-2">
          <Link href="/signup" className={LINK_CLASS}>
            Create an account
          </Link>
          <Link href="/login" className={LINK_CLASS}>
            Sign in
          </Link>
        </div>
      </Card>
    );
  }

  if (session.email !== invite.email) {
    return (
      <Card>
        <h2 className="text-[15px] font-semibold tracking-tight text-gray-900">Wrong account for this invitation</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-gray-600">
          It was sent to <span className="font-mono text-gray-900">{invite.email}</span>, and you are
          signed in as <span className="font-mono text-gray-900">{session.email}</span>.
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-gray-500">
          This is deliberate. A link that any account could redeem is a link that can be forwarded,
          and then it is not an invitation to a person but to whoever has it.
        </p>
        <form action={signOut} className="mt-5">
          <button type="submit" className={LINK_CLASS}>
            Sign out and use another account
          </button>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-[15px] font-semibold tracking-tight text-gray-900">Join {invite.workspace.name}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-gray-600">
        You are signed in as <span className="font-mono text-gray-900">{session.email}</span>, the
        address this invitation was sent to. Accepting adds you as {roleLabel}.
      </p>
      <AcceptInvite token={token} />
    </Card>
  );
}
