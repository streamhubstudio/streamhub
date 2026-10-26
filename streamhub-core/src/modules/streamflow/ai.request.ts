/**
 * PURE request/response shaping for the Streamflow AI client (OpenAI-compatible
 * /v1/chat/completions — OpenAI or DeepSeek by base-URL swap). Split out from
 * ai.client.ts so it is trivially unit-testable with NO network: message
 * shaping (text vs vision content array), base64 → data: URI handling, the
 * per-provider base URL, response parsing and a coarse cost estimate.
 *
 * NEVER put the API key in here — the client attaches Authorization; this module
 * only shapes the URL + body + non-secret headers.
 */

export type AiProvider = 'openai' | 'deepseek';

export interface AiChatOptions {
  /** Provider (drives the default base URL). Default 'openai'. */
  provider?: AiProvider;
  /** Model id, e.g. 'gpt-4o-mini' | 'deepseek-chat'. */
  model: string;
  /** User prompt text. */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /** Vision input: an http(s) URL OR a `data:` URI (used as-is). */
  imageUrl?: string;
  /** Vision input: RAW base64 (no `data:` prefix) — wrapped as a data: URI. */
  imageBase64?: string;
  /** MIME for `imageBase64` (default image/jpeg). */
  imageMime?: string;
  /** Cap the completion length. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Ask for a strict JSON object back (response_format). */
  jsonMode?: boolean;
  /** Override the base URL (SSRF-guarded by the client). */
  baseUrl?: string;
}

export interface BuiltChatRequest {
  url: string;
  body: Record<string, unknown>;
  /** Non-secret headers only (the client adds Authorization). */
  headers: Record<string, string>;
}

export interface ParsedChatResponse {
  text: string;
  usageTokens: number;
  raw: unknown;
}

/** Default API base URL for a provider (includes the `/v1`). */
export function providerBaseUrl(provider: AiProvider = 'openai'): string {
  return provider === 'deepseek'
    ? 'https://api.deepseek.com/v1'
    : 'https://api.openai.com/v1';
}

type MessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

/** Resolve the image input to a single URL/data-URI string, or undefined. */
export function resolveImageSource(opts: AiChatOptions): string | undefined {
  if (opts.imageUrl && opts.imageUrl.trim()) return opts.imageUrl.trim();
  if (opts.imageBase64 && opts.imageBase64.trim()) {
    const b64 = opts.imageBase64.trim();
    // Already a data: URI? use as-is.
    if (b64.startsWith('data:')) return b64;
    const mime = (opts.imageMime || 'image/jpeg').trim();
    return `data:${mime};base64,${b64}`;
  }
  return undefined;
}

/** Shape the user message content: a bare string, or a text+image array. */
export function buildUserContent(opts: AiChatOptions): MessageContent {
  const image = resolveImageSource(opts);
  if (!image) return opts.prompt;
  return [
    { type: 'text', text: opts.prompt },
    { type: 'image_url', image_url: { url: image } },
  ];
}

/**
 * Build the full /chat/completions request (URL + JSON body + non-secret
 * headers). The base URL is `opts.baseUrl` when set, else the provider default;
 * the path `/chat/completions` is appended (trailing slashes trimmed).
 */
export function buildChatRequest(opts: AiChatOptions): BuiltChatRequest {
  const base = (opts.baseUrl?.trim() || providerBaseUrl(opts.provider)).replace(
    /\/+$/,
    '',
  );
  const messages: Array<{ role: string; content: MessageContent }> = [];
  if (opts.system && opts.system.trim()) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: buildUserContent(opts) });

  const body: Record<string, unknown> = { model: opts.model, messages };
  if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
    body.max_tokens = Math.floor(opts.maxTokens);
  }
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  return {
    url: `${base}/chat/completions`,
    body,
    headers: { 'content-type': 'application/json' },
  };
}

/** Parse a chat completion response into { text, usageTokens, raw }. */
export function parseChatResponse(raw: unknown): ParsedChatResponse {
  const obj = (raw ?? {}) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { total_tokens?: unknown };
  };
  const content = obj.choices?.[0]?.message?.content;
  const total = obj.usage?.total_tokens;
  return {
    text: typeof content === 'string' ? content : content == null ? '' : String(content),
    usageTokens: typeof total === 'number' && Number.isFinite(total) ? total : 0,
    raw,
  };
}

/**
 * Coarse blended $/1K-token cost estimate — a BUDGET-GUARD heuristic, not
 * billing. Unknown models fall back to a conservative default so the cap still
 * engages. Prices are intentionally rough and easy to tune.
 */
const PRICE_PER_1K_USD: Record<string, number> = {
  'gpt-4o-mini': 0.0006,
  'gpt-4o': 0.008,
  'gpt-4.1-mini': 0.0006,
  'gpt-4.1': 0.006,
  'o4-mini': 0.002,
  'deepseek-chat': 0.0003,
  'deepseek-reasoner': 0.001,
};
const PRICE_DEFAULT_USD = 0.002;

export function estimateUsd(model: string, tokens: number): number {
  const per1k = PRICE_PER_1K_USD[model] ?? PRICE_DEFAULT_USD;
  const t = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0;
  return (Math.max(0, t) / 1000) * per1k;
}
