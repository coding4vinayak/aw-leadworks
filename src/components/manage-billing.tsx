"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Opens the Stripe billing portal for the signed-in workspace — where a
 * customer changes their card, downloads invoices or cancels. Session-gated for
 * the same reason checkout is: the portal manages *someone's* billing, so it
 * can only ever act on the workspace the current session belongs to.
 */
export function ManageBillingButton({ label = "Manage billing" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnUrl: `${window.location.origin}/dashboard?billing=portal` }),
      });
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError(data.error ?? "Could not open the billing portal.");
    } catch {
      setError("Could not open the billing portal.");
    }
    setBusy(false);
  }

  return (
    <span>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? "Opening…" : label}
      </button>
      {error && <span className="ml-2 text-[11px] text-red-500">{error}</span>}
    </span>
  );
}