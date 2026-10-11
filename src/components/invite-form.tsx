"use client";

import { useRef, useState } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { inviteMember, type MembersActionState } from "@/app/member-actions";

/**
 * The invite control on /members.
 *
 * Sits beside a generated link rather than in an email client, because nothing
 * in this product sends mail yet — see the note under the form. The shape is the
 * one the API key manager already uses: a link exists in exactly one response and
 * is never shown twice, since only its hash survives in the database.
 */

const INITIAL: MembersActionState = {};

const INPUT_CLASS =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-600-dim focus:border-muted-dim focus:outline-none";

function Message({ tone, children }: { tone: "error" | "notice"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
        tone === "error"
          ? "border-red-400/40 bg-red-50 text-gray-900"
          : "border-gray-300 bg-white text-gray-600"
      }`}
    >
      {children}
    </p>
  );
}

function InviteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-md bg-foreground px-3 py-2 text-[12px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Creating…" : "Invite"}
    </button>
  );
}

/**
 * The accept link, shown once.
 *
 * navigator.clipboard needs a secure context, which plain http on a LAN address
 * during a demo is not, so the fallback selects the text instead of failing
 * silently and leaving the person with nothing to send.
 */
function RevealedLink({
  email,
  role,
  link,
}: {
  email: string;
  role: string;
  link: string;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      field.current?.select();
    }
  }

  return (
    <div className="rounded-lg border border-gray-300 bg-white-raised p-3.5">
      <p className="text-[12px] font-medium text-gray-900">
        Send this link to <span className="font-mono">{email}</span> — it grants{" "}
        {role === "ADMIN" ? "admin" : "member"} access
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-gray-600">
        It works once, expires in seven days, and only for an account with that address. This is
        the only time it appears: the database keeps a hash, so losing it means inviting them
        again, which retires the link you had.
      </p>
      {/* "Seven days" restates INVITE_TTL_DAYS in lib/invites.ts as text, the same way
          api-key-manager restates MAX_NAME_LENGTH: a client component cannot import a
          module that reaches for the database. The server enforces the real number. */}
      <div className="mt-2.5 flex items-center gap-2">
        <input
          ref={field}
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className={`${INPUT_CLASS} font-mono text-[12px]`}
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-[12px] text-gray-900 transition hover:bg-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function InviteForm({ roles }: { roles: Array<{ value: string; label: string }> }) {
  const [state, submit] = useActionState(inviteMember, INITIAL);

  return (
    <div className="space-y-3">
      {state.revealed && <RevealedLink {...state.revealed} />}
      {state.error && <Message tone="error">{state.error}</Message>}

      <form action={submit} className="flex flex-wrap items-center gap-2">
        <input
          name="email"
          type="email"
          maxLength={254}
          placeholder="teammate@company.com"
          aria-label="Email address to invite"
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />
        <select
          name="role"
          aria-label="Access to grant"
          defaultValue={roles[0]?.value ?? "MEMBER"}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 focus:border-muted-dim focus:outline-none"
        >
          {roles.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </select>
        <InviteButton />
      </form>

      <p className="text-[12px] leading-relaxed text-gray-600-dim">
        abetConnect does not send the email for you yet — there is no mail provider wired in. Copy
        the link and paste it into a message you already trust, the same way you would hand over a
        staging password. A person who needs an account first signs up with this address, then
        opens the link; the invitation is still live when they do.
      </p>
    </div>
  );
}
