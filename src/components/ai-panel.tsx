"use client";

import { useState } from "react";

/**
 * The UI for the AI features.
 *
 * These endpoints existed with no way to reach them from a browser, which makes
 * them a feature only the author can use. This panel is the other half: pick a
 * record, run the feature, read the result in place.
 *
 * Two rules the panel enforces on the user's behalf:
 *
 * 1. It never shows a draft as if it were sent. AI output is labelled as a
 *    draft or a suggestion, and the copy says a human still reviews it. A
 *    product that blurs "suggested" into "done" is how an AI feature loses a
 *    customer's trust permanently.
 * 2. It reports "not configured" as itself. With no provider key the endpoint
 *    answers `configured: false`; the panel says so instead of rendering an
 *    empty result that looks like the model had nothing to say.
 *
 * The response shape differs per product, so the panel renders whatever blocks
 * it is given rather than assuming one layout.
 */

export interface AiOption {
  id: string;
  label: string;
}

/**
 * Describes how to render the response.
 *
 * A function cannot cross the server/client boundary, so the product page
 * passes this plain descriptor and the client panel does the rendering. `path`
 * is a dotted key into the response; `list: true` means expect an array.
 */
export interface AiField {
  path: string;
  title: string;
  /** Monospace block — drafts, keys, commands. */
  mono?: boolean;
  /** Render as a bulleted list. */
  list?: boolean;
  /** Skip this field when the value is empty. */
  optional?: boolean;
}

export interface AiBlock {
  title: string;
  body: string;
  mono?: boolean;
  items?: string[];
}

function readPath(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, data);
}

function toBlocks(data: unknown, fields: AiField[]): AiBlock[] {
  const blocks: AiBlock[] = [];
  for (const f of fields) {
    const value = readPath(data, f.path);
    if (f.list) {
      if (Array.isArray(value) && value.length > 0) {
        blocks.push({
          title: f.title,
          body: "",
          items: value.filter((v): v is string => typeof v === "string" && v.trim().length > 0),
        });
      }
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      blocks.push({ title: f.title, body: value.trim(), mono: f.mono });
    } else if (typeof value === "number" && !f.optional) {
      blocks.push({ title: f.title, body: String(value) });
    }
  }
  return blocks;
}

export interface AiPanelConfig {
  title: string;
  blurb: string;
  /** Route to call, relative, e.g. "/api/ai/draft-reply". */
  endpoint: string;
  method?: "POST" | "GET";
  /** What the picker is choosing, e.g. "enrollment". */
  entityLabel: string;
  options: AiOption[];
  /** Extra free-text field, e.g. the reply being answered. */
  inputLabel?: string;
  /**
   * The JSON key `inputLabel`'s text is sent under. "reply" is what
   * `/api/ai/draft-reply` reads, and the name a panel with one text box needs no
   * opinion about; abetflow's `/api/ai/try-node` calls it `text`, because the node
   * it runs works on any text, not a reply. Left unset here and the playground 400s
   * — the route asked for `text` and the panel only ever sent `reply`.
   */
  inputField?: string;
  inputPlaceholder?: string;
  /** Whether the chosen record's id needs wrapping in a JSON field. */
  idField: string;
  /** Workspace id to send, when the route wants one. */
  workspaceId?: string;
  buttonLabel: string;
  /** True when a draft/suggestion must be labelled as unsent. */
  draft?: boolean;
  emptyText: string;
}

export function AiPanel({
  config,
  fields,
}: {
  config: AiPanelConfig;
  /** Plain data describing the response, so the server page can pass it. */
  fields: AiField[];
}) {
  const [selected, setSelected] = useState(config.options[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocks, setBlocks] = useState<AiBlock[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!selected) {
      setError(`Choose a ${config.entityLabel} first.`);
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const method = config.method ?? "POST";
      const payload: Record<string, unknown> = { [config.idField]: selected };
      if (config.workspaceId) payload.workspaceId = config.workspaceId;
      if (config.inputLabel) payload[config.inputField ?? "reply"] = input;

      const res = await fetch(config.endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(payload),
      });
      const data = (await res.json()) as Record<string, unknown>;

      if (data.configured === false) {
        setNote("AI is not configured on this deployment. Set LLM_API_KEY to turn it on.");
        setBlocks(null);
        return;
      }
      // `signal` is a differently-shaped object per product, so it is read
      // defensively rather than typed — a missing or non-object field is simply
      // "not an opt-out".
      const signal = data.signal;
      const signalKind =
        signal !== null && typeof signal === "object" ? (signal as { kind?: unknown }).kind : undefined;
      if (data.action === "unsubscribe" || signalKind === "unsubscribe") {
        setNote("That reply is an opt-out — honour it and pause the enrollment. No draft was written.");
        setBlocks(null);
        return;
      }
      if (!res.ok) {
        // Two shapes reach here: a gateway envelope (`{ error: { code, message } }`,
        // what a wrong field or a bad key answers on the apps that have a gateway)
        // and a route's own `{ error: "webhook not found" }`. `String(data.error)`
        // rendered the first as "[object Object]", so the message is pulled out when
        // there is one and the bare string is used when it is one.
        const envelope = data.error as { message?: unknown } | string | undefined;
        const message =
          typeof envelope === "string" ? envelope : envelope && typeof envelope.message === "string" ? envelope.message : undefined;
        setError(String(data.reason ?? message ?? `Request failed (${res.status}).`));
        setBlocks(null);
        return;
      }
      if (data.drafted === false || data.explained === false || data.diagnosed === false) {
        setNote(String(data.reason ?? "Nothing to show."));
        setBlocks(null);
        return;
      }
      setBlocks(toBlocks(data, fields));
      setNote(null);
    } catch {
      setError("Could not reach the server.");
      setBlocks(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">{config.title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-gray-600">{config.blurb}</p>

      {config.options.length === 0 ? (
        <p className="mt-3 text-[12px] text-gray-500">{config.emptyText}</p>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {config.entityLabel}
            </span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 focus:border-gray-500 focus:outline-none"
            >
              {config.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          {config.inputLabel && (
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
                {config.inputLabel}
              </span>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={3}
                placeholder={config.inputPlaceholder}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-gray-500 focus:outline-none"
              />
            </label>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-gray-800">
              {error}
            </p>
          )}
          {note && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              {note}
            </p>
          )}

          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="rounded-md bg-gray-900 px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Working…" : config.buttonLabel}
          </button>
        </div>
      )}

      {blocks && blocks.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
          {config.draft && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-900">
              Draft only — nothing was sent. A human reads this and sends it.
            </p>
          )}
          {blocks.map((b) => (
            <div key={b.title}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{b.title}</p>
              {b.items ? (
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-[13px] text-gray-700">
                  {b.items.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              ) : b.mono ? (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-gray-50 p-3 font-mono text-[12px] text-gray-900">
                  {b.body}
                </pre>
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">{b.body}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
