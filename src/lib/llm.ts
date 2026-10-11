/**
 * Optional LLM access, shared by every AI feature in this app.
 *
 * The contract is the whole point: **`complete` never throws and never blocks
 * the product.** No key, a down provider, a timeout, a refusal, or malformed
 * JSON all return `null` and the caller falls back to its deterministic path.
 * An outage at the provider must not become an outage here.
 *
 * Configuration (all optional — the app is fully functional without them):
 *   LLM_API_KEY     any OpenAI-compatible key; you pay the provider
 *   LLM_BASE_URL    defaults to https://api.openai.com/v1
 *   LLM_MODEL       per-feature default, overridable per call
 *   LLM_TIMEOUT_MS  defaults to 12000
 */

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

function baseUrl(): string {
  return (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
}

function timeoutMs(): number {
  return Number(process.env.LLM_TIMEOUT_MS ?? 12000);
}

/**
 * One chat completion. Returns null — never throws — when the model is
 * unavailable or unhelpful, so every caller can be written as
 * `const ai = await complete(...); return ai ?? heuristic();`
 */
export async function complete(
  system: string,
  user: string,
  options: { model?: string; temperature?: number; maxTokens?: number } = {},
): Promise<LlmResult | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;

  const model = options.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs());
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 600,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    return {
      text,
      model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
      },
    };
  } catch {
    // Timeout, DNS, refused connection, abort — all indistinguishable to a
    // caller, and all equally "no answer this time".
    return null;
  }
}

/**
 * Structured output. The model is asked for JSON and the result is parsed
 * defensively (models wrap JSON in prose more often than anyone would like);
 * anything unparseable degrades to `null`, same as any other failure.
 */
export async function completeJson<T>(
  system: string,
  user: string,
  options: { model?: string; temperature?: number; maxTokens?: number; schemaHint?: string } = {},
): Promise<{ data: T; usage: LlmUsage; model: string } | null> {
  const schema = options.schemaHint ? `\n\nRespond with JSON matching exactly this shape:\n${options.schemaHint}` : "\n\nRespond with JSON only. No prose, no code fences.";
  const result = await complete(system, `${user}${schema}`, { ...options, temperature: options.temperature ?? 0 });

  if (!result) return null;

  const text = result.text.trim();
  // Strip a fenced block if the model added one, then take the outermost {...}.
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const candidate = start !== -1 && end > start ? unfenced.slice(start, end + 1) : unfenced;

  try {
    return { data: JSON.parse(candidate) as T, usage: result.usage, model: result.model };
  } catch {
    return null;
  }
}
