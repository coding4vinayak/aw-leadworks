import { prisma } from "./db";
import { canEditRole, canGrant } from "./roles";

/**
 * Changing or ending an existing seat.
 *
 * Invitations only ever *add* access, so this is the half that fixes a mistake:
 * the member who should have been an admin, the colleague who has left. It lives in
 * lib rather than in the server action for the same reason the invite rules do — it
 * is the most powerful thing an owner can click, and it has to be drivable from a
 * script against a real database instead of read and hoped over.
 *
 * Three rules hold it together:
 *
 *   - The workspace comes from the caller's session, and the seat is looked up by
 *     id *within* it. A membership id from another tenant resolves to nothing.
 *   - canEditRole decides whether this seat is yours to touch, so an admin cannot
 *     re-role another admin, and nobody can touch an owner from inside the product.
 *   - canGrant decides which roles may be handed out, so the dropdown cannot
 *     sidestep "only an owner may make an admin" — an invite and a role change are
 *     the same privilege wearing different clothes.
 */

/** Not a role. An instruction to take the seat away, kept out of the role
 *  namespace so a made-up role can never be spelled like a verb. */
export const REMOVE = "REMOVE";

/** The role names go into sentences, so the article has to follow them rather
 *  than being hardcoded to "a". */
function article(role: string): string {
  return role === "ADMIN" || role === "OWNER" ? "an" : "a";
}

export type SeatOutcome =
  | { ok: true; action: "role" | "removed" | "unchanged"; who: string; role?: string }
  | { ok: false; error: string };

export async function editSeat(input: {
  workspaceId: string;
  membershipId: string;
  actorRole: string;
  role: string;
}): Promise<SeatOutcome> {
  const seat = await prisma.membership.findFirst({
    where: { id: input.membershipId, workspaceId: input.workspaceId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!seat) return { ok: false, error: "That seat is not in your workspace." };

  if (!canEditRole(input.actorRole, seat.role)) {
    return {
      ok: false,
      error:
        `As ${article(input.actorRole)} ${input.actorRole.toLowerCase()}, ` +
        `you cannot change ${article(seat.role)} ${seat.role.toLowerCase()} seat.`,
    };
  }

  const who = seat.user.name || seat.user.email;

  if (input.role === REMOVE) {
    await prisma.$transaction([
      prisma.membership.delete({ where: { id: seat.id } }),
      // Their cookie was minted in this workspace. Delete the seat alone and the
      // browser keeps a workspace it has been removed from until something else
      // reloads: the row is gone but the session still names the id. Other
      // workspaces this account belongs to are untouched, which is why the filter
      // is the pair rather than the user alone.
      prisma.session.deleteMany({
        where: { userId: seat.userId, workspaceId: seat.workspaceId },
      }),
    ]);
    return { ok: true, action: "removed", who };
  }

  const grantable = canGrant(input.actorRole, input.role);
  if (!grantable.ok) return { ok: false, error: grantable.error };
  if (input.role === seat.role) return { ok: true, action: "unchanged", who, role: input.role };

  await prisma.membership.update({ where: { id: seat.id }, data: { role: input.role } });
  return { ok: true, action: "role", who, role: input.role };
}
