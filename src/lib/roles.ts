/**
 * What the roles mean, and who may hand them out.
 *
 * Its own module because this is the only file that answers "is this person
 * allowed to do that", and it must not import the database, `next/headers` or
 * anything else a browser request brings with it. `lib/invites.ts` uses these,
 * the API key actions use them, and `scripts/check-invites.ts` tests them
 * directly — so the answer an operator gets about whether a MEMBER can mint a
 * key is a fact with a test behind it, not something read off the shape of a
 * page that happens to hide a button.
 *
 * There are three roles and they are deliberately blunt. Fine-grained
 * permissions (this seat may reply but not read billing, etc.) are not modelled
 * and are not pretended to here: a MEMBER can see every conversation in the
 * workspace it belongs to, which is the right answer for a small team and the
 * wrong one for something bigger.
 */

/**
 * The roles an invitation can carry.
 *
 * OWNER is absent on purpose. Signup creates an OWNER membership and nothing in
 * an invite path can mint one, so "accept this link" can never turn into "this
 * stranger owns the workspace, its API keys and its customers' messages".
 * Ownership changes hands through an explicit transfer, which does not exist
 * yet — a decision, not an oversight, recorded in the README.
 */
export const INVITABLE_ROLES = ["ADMIN", "MEMBER"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(value: string): value is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Whether a role may manage credentials and people.
 *
 * MEMBER is excluded, which is the whole point of having a third role: the
 * colleague who works the queue cannot create a long-lived key that outlives
 * their employment, or invite the next person in.
 */
export function canManageRoles(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * Whether `granter` may issue `target`.
 *
 * An ADMIN can invite colleagues but cannot create another ADMIN. Without that
 * rule a single compromised admin account quietly duplicates itself, and the only
 * person able to notice is the owner who is not in the room. Escalation between
 * the two issuable roles needs the owner.
 */
export function canGrant(
  granter: string | null | undefined,
  target: string,
): { ok: true } | { ok: false; error: string } {
  if (!canManageRoles(granter)) {
    return { ok: false, error: "Only an owner or admin can invite people." };
  }
  if (!isInvitableRole(target)) {
    return { ok: false, error: "Invitations can grant admin or member access." };
  }
  if (granter !== "OWNER" && target === "ADMIN") {
    // Worded for both places this is consulted: sending an invitation and
    // re-roling an existing seat are the same privilege.
    return { ok: false, error: "Only an owner can grant admin access." };
  }
  return { ok: true };
}

/** Whether a role may change or remove another person's access. */
export function canEditRole(actor: string | null | undefined, target: string): boolean {
  if (!canManageRoles(actor)) return false;
  if (actor === "OWNER") return target !== "OWNER";
  // An admin may demote or remove a member, never an equal or an owner.
  return target === "MEMBER";
}
