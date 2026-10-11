"use client";

import { useState } from "react";

/**
 * First-run API key prompt.
 *
 * A new account is useless for anything automated until it has a key, and the
 * only way to get one was to already know the key API. This shows up on the
 * dashboard while the workspace has no live key, mints one on click, and shows
 * the plaintext exactly once.
 *
 * Why a server action rather than a `POST /api/keys` call: the plaintext has to
 * reach the person who may keep it, and a server action returns it straight
 * into component state. Going through an HTTP route would put the one secret
 * this product can never re-show into a response body, and passing it in a
 * redirect would put it in a URL, where it lands in access logs and referrers.
 *
 * The action is passed in rather than imported, because minting differs per
 * product — AbetAPI has scopes and a rate-limit ceiling, the rest do not — and
 * this file stays byte-identical everywhere.
 */

export interface FirstKeyResult {
  ok: boolean;
  /** Present only on success, and never again. */
  plaintext?: string;
  prefix?: string;
  error?: string;
}

export function ApiKeyOnboarding({ createKey }: { createKey: () => Promise<FirstKeyResult> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FirstKeyResult | null>(null);

  async function mint() {
    setBusy(true);
    try {
      setResult(await createKey());
    } catch {
      // The action is a server call; a dropped connection is not a reason to
      // show a stack trace or a fake success.
      setResult({ ok: false, error: "Could not reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }

  if (result?.ok && result.plaintext) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
        <h2 className="text-sm font-semibold text-emerald-900">Your API key is ready</h2>
        <p className="mt-1 text-[13px] text-emerald-800">
          Copy it now — only a hash is stored, so it cannot be shown again. If you lose
          it, create another.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code
            className="flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-emerald-300 bg-white px-3 py-2 font-mono text-[12px] text-gray-900"
            data-testid="first-api-key"
          >
            {result.plaintext}
          </code>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(result.plaintext ?? "")}
            className="shrink-0 rounded-md bg-emerald-700 px-3 py-2 text-[12px] font-medium text-white hover:bg-emerald-800"
          >
            Copy
          </button>
        </div>
        <p className="mt-3 text-[12px] text-emerald-800">
          Send it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
      <h2 className="text-sm font-semibold text-amber-900">Create your API key</h2>
      <p className="mt-1 text-[13px] text-amber-800">
        {result?.error
          ? result.error
          : "Everything you automate — scripts, integrations, the SDK — authenticates with an API key. Yours will be shown once."}
      </p>
      <button
        type="button"
        onClick={mint}
        disabled={busy}
        className="mt-3 rounded-md bg-amber-700 px-4 py-2 text-[12px] font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "Creating…" : "Create API key"}
      </button>
    </div>
  );
}
