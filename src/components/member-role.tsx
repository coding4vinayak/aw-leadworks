"use client";

import { useActionState } from "react";
import { changeMemberRole, type MembersActionState } from "@/app/member-actions";

/**
 * The role control on each row of /members.
 *
 * A select that submits itself: changing a seat's access is one decision, and a
 * second "Save" button next to a dropdown is a chance to change it twice or to
 * change it and walk away. The payload is built here rather than read back out of
 * the form, so there is exactly one place the two fields can come from.
 *
 * No options means the server has decided this seat is not yours to edit, and the
 * plain label in the page markup stays. The real check is canEditRole inside the
 * action; this is only about not offering a control that cannot work.
 */

const INITIAL: MembersActionState = {};

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  REMOVE: "No access",
};

export type RoleOption = { value: string; label: string };

export function MemberRole({
  membershipId,
  role,
  label,
  options,
}: {
  membershipId: string;
  role: string;
  label: string;
  options: RoleOption[];
}) {
  const [state, submit] = useActionState(changeMemberRole, INITIAL);

  if (options.length === 0) return null;

  const offered = options.some((o) => o.value === role)
    ? options
    : [{ value: role, label: ROLE_LABELS[role] ?? role }, ...options];

  return (
    <form action={submit} className="ml-auto flex flex-wrap items-center gap-2">
      {/* Also present so a form submitted without JavaScript still carries the seat
          it belongs to; the change handler builds the same two fields itself. */}
      <input type="hidden" name="membership" value={membershipId} />
      <label className="text-[11px] text-gray-600-dim">
        <span className="sr-only">Access for {label}</span>
        <select
          name="role"
          defaultValue={role}
          aria-label={`Access for ${label}`}
          onChange={(event) => {
            // Built here rather than read back out of the form, so there is one
            // place the two fields can come from.
            const payload = new FormData();
            payload.set("membership", membershipId);
            payload.set("role", event.target.value);
            submit(payload);
          }}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-900 focus:border-muted-dim focus:outline-none"
        >
          {offered.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {state.error && (
        <span role="alert" className="text-[11px] text-red-700">
          {state.error}
        </span>
      )}
      {state.notice && (
        <span role="status" className="text-[11px] text-gray-600-dim">
          {state.notice}
        </span>
      )}
    </form>
  );
}
