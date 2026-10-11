"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { acceptInvitation, type AcceptState } from "@/app/member-actions";

/**
 * The single button on an invitation link.
 *
 * A client component only because React needs the token bound into the action
 * before the form is submitted — nothing here decides whether the invitation is
 * good. acceptInvite does that, on the server, every time.
 */

const INITIAL: AcceptState = {};

function AcceptButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="accept"
      value="1"
      disabled={pending}
      className="rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Joining…" : "Join this workspace"}
    </button>
  );
}

export function AcceptInvite({ token }: { token: string }) {
  const [state, submit] = useActionState(acceptInvitation.bind(null, token), INITIAL);

  return (
    <form action={submit} className="mt-6 space-y-3">
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-red-400/40 bg-red-50 px-3 py-2 text-[12px] leading-relaxed text-gray-900"
        >
          {state.error}
        </p>
      )}
      <AcceptButton />
      <p className="text-[11px] leading-relaxed text-gray-600-dim">
        Joining gives this account access to the workspace&rsquo;s conversations. It does not create
        an API key, and it does not make you an owner.
      </p>
    </form>
  );
}
