import { prisma } from "./db";
import { getSession, type ActiveSession } from "./session";

/**
 * Which workspace a dashboard request is allowed to read.
 *
 * Before login existed, the dashboard took a workspace slug straight from the
 * query string: `?workspace=acme` showed Acme's numbers to anyone who guessed
 * or guessed-and-checked the slug. Adding a login that the dashboard then
 * ignores would have been decoration, so the policy is enforced here, in one
 * place, rather than trusted to six page files that each remember it slightly
 * differently.
 *
 * The rules:
 *
 * 1. The `demo` workspace is public on purpose. It is what the landing pages
 *    link to, it is seeded with sample rows, and a product whose demo needs
 *    credentials is a product nobody evaluates.
 * 2. A signed-in customer gets their own workspace with no query string.
 * 3. A signed-in customer may also *look at* the demo, but nothing else. Naming
 *    someone else's slug gets a refusal rather than their numbers, because the
 *    alternative is a customer-to-customer data leak via a URL.
 * 4. No session, non-demo slug: point at the login form. Never a redirect that
 *    loses the slug, and never the data.
 */

/** The public sample workspace's slug. Matched exactly, never by prefix. */
export const DEMO_SLUG = "demo";

const SLIM = { select: { id: true, name: true, slug: true } } as const;

export type WorkspaceResolution =
  | {
      workspace: { id: string; name: string; slug: string };
      session: ActiveSession | null;
      via: "demo" | "session" | "session-viewing-demo";
    }
  | { workspace: null; session: ActiveSession | null; reason: "signin-required"; slug: string };

export async function resolveWorkspace(requested?: string): Promise<WorkspaceResolution> {
  const session = await getSession();
  const slug = requested?.trim() ? requested.trim() : undefined;

  // Rule 1: the demo is public to everyone, signed in or not. One lookup,
  // because this is the path every anonymous visitor takes.
  if (slug === DEMO_SLUG) {
    const demo = await prisma.workspace.findUnique({ where: { slug: DEMO_SLUG }, ...SLIM });
    if (demo) {
      return { workspace: demo, session, via: session ? "session-viewing-demo" : "demo" };
    }
    // The demo has not been seeded. A signed-in customer still gets their own
    // workspace; anyone else is sent to sign in rather than shown a blank page.
  }

  // Rule 2: no slug named — a session decides.
  if (!slug) {
    if (session) {
      const own = await prisma.workspace.findUnique({ where: { id: session.workspaceId }, ...SLIM });
      if (own) return { workspace: own, session, via: "session" };
    }
    const demo = await prisma.workspace.findUnique({ where: { slug: DEMO_SLUG }, ...SLIM });
    if (demo) return { workspace: demo, session: null, via: "demo" };
    return { workspace: null, session, reason: "signin-required", slug: "" };
  }

  // Rule 3: a slug was named. The only one that may be served is the caller's
  // own — matched by id, not by slug equality, so a renamed workspace cannot
  // turn a stale link into someone else's data.
  if (session) {
    const own = await prisma.workspace.findUnique({ where: { id: session.workspaceId }, ...SLIM });
    if (own && own.slug === slug) return { workspace: own, session, via: "session" };
  }

  // Anything else — a foreign slug, or an anonymous visitor naming one — is
  // refused. A non-existent slug lands here too, deliberately: telling a
  // signed-out visitor which slugs exist is a free enumeration oracle.
  return { workspace: null, session, reason: "signin-required", slug };
}
