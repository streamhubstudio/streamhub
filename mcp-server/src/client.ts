/**
 * Thin typed HTTP client over the StreamHub REST API (`/api/v1`).
 *
 * Responsibilities:
 * - attach the `Authorization: Bearer sk_...` header on every call;
 * - serialize query params (skipping undefined/null);
 * - unwrap the `{ data, error }` response envelope (and the paginated
 *   `{ data, total, limit, offset }` variant);
 * - turn non-2xx responses (NestJS error bodies) into StreamHubApiError.
 *
 * No retries and no streaming: the MCP layer surfaces errors to the model.
 */

export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

/** The surface tools depend on — kept small so tests can fake it trivially. */
export interface HttpClient {
  get(path: string, opts?: { query?: Query }): Promise<unknown>;
  post(path: string, body?: unknown, opts?: { query?: Query }): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  del(path: string, opts?: { query?: Query }): Promise<unknown>;
}

export class StreamHubApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'StreamHubApiError';
    this.status = status;
    this.body = body;
  }
}

/** Drop keys whose value is `undefined` (JSON bodies stay minimal + testable). */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Unwrap the StreamHub `{ data, error }` envelope.
 *
 * - `{ data, error: null }`                → the inner `data`
 * - `{ data, total, limit, offset }`       → `{ items, total, limit, offset }`
 * - anything else (e.g. bare payloads)     → passed through untouched
 */
export function unwrapEnvelope(body: unknown, status = 200): unknown {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    const b = body as Record<string, unknown>;
    if ('error' in b && b.error !== null && b.error !== undefined) {
      const msg =
        typeof b.error === 'string' ? b.error : `StreamHub returned an error: ${JSON.stringify(b.error)}`;
      throw new StreamHubApiError(status, msg, body);
    }
    if ('total' in b) {
      return { items: b.data, total: b.total, limit: b.limit, offset: b.offset };
    }
    return b.data;
  }
  return body;
}

/** Extract a human message from a NestJS error body (`message` may be an array). */
export function extractErrorMessage(parsed: unknown, status: number): string {
  if (parsed !== null && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    const msg = p.message;
    if (Array.isArray(msg)) return msg.map(String).join('; ');
    if (typeof msg === 'string' && msg.length > 0) return msg;
    if (typeof p.error === 'string' && p.error.length > 0) return p.error;
  }
  if (typeof parsed === 'string' && parsed.trim().length > 0) return parsed.trim();
  return `HTTP ${status}`;
}

export class StreamHubClient implements HttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: { baseUrl: string; token: string }, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = cfg.baseUrl;
    this.token = cfg.token;
    this.fetchImpl = fetchImpl;
  }

  /** Origin without the /api/v1 prefix (for /play, /embed, /hls links). */
  get origin(): string {
    return this.baseUrl.replace(/\/api\/v1$/, '');
  }

  buildUrl(path: string, query?: Query): string {
    let url = this.baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    return url;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new StreamHubApiError(
        0,
        `Cannot reach StreamHub at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 204) return { ok: true };

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new StreamHubApiError(res.status, extractErrorMessage(parsed, res.status), parsed);
    }
    return unwrapEnvelope(parsed, res.status);
  }

  get(path: string, opts?: { query?: Query }): Promise<unknown> {
    return this.request('GET', path, { query: opts?.query });
  }
  post(path: string, body?: unknown, opts?: { query?: Query }): Promise<unknown> {
    return this.request('POST', path, { body, query: opts?.query });
  }
  patch(path: string, body?: unknown): Promise<unknown> {
    return this.request('PATCH', path, { body });
  }
  put(path: string, body?: unknown): Promise<unknown> {
    return this.request('PUT', path, { body });
  }
  del(path: string, opts?: { query?: Query }): Promise<unknown> {
    return this.request('DELETE', path, { query: opts?.query });
  }
}
