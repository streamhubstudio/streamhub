/**
 * Streamflow AI client — a thin OpenAI-compatible /v1/chat/completions caller
 * (OpenAI, or DeepSeek by base-URL swap) used by the `action.ai` box.
 *
 * Safety:
 *  - the base URL is SSRF-guarded (assertSafeEgressUrl) before any dial;
 *  - an AbortController bounds the request time;
 *  - the API key comes from the plugin config (`ai_api_key`) or the SecretsStore
 *    (never logged, never returned in results/errors);
 *  - a per-app MONTHLY spend estimate is persisted (StreamflowStore.ai_usage)
 *    and the call FAILS CLOSED once the configured budget is reached.
 *
 * Request/response shaping is delegated to the pure ai.request helpers so the
 * network-touching logic here stays tiny and the shaping is unit-tested alone.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { SecretsStore } from '../s3/secrets.store';
import {
  assertSafeEgressUrl,
  defaultHostResolver,
  HTTP_SCHEMES,
  type HostResolver,
} from '../security/egress-url.guard';
import {
  AiChatOptions,
  buildChatRequest,
  estimateUsd,
  parseChatResponse,
} from './ai.request';

/** DI token: the AI budget usage tracker (bound to StreamflowStore). */
export const AI_USAGE_TRACKER = Symbol('AI_USAGE_TRACKER');

/** Minimal usage-tracker seam the budget guard reads/writes (StreamflowStore). */
export interface AiUsageTracker {
  monthlyUsd(app: string, appDir: string): number;
  addUsage(app: string, appDir: string, tokens: number, usd: number): void;
}

export interface AiChatRequestInput extends AiChatOptions {
  /** App the call is billed against (budget bucket). */
  app: string;
  /** Absolute apps/<app>/ dir (streamflow.db location). */
  appDir: string;
  /** Resolved API key (plugin config `ai_api_key`). Preferred over the ref. */
  apiKey?: string;
  /** SecretsStore ref to resolve when `apiKey` is empty. */
  apiKeyRef?: string;
  /** Monthly USD cap; <= 0 disables the cap. */
  budgetUsd?: number;
  /** Request timeout (ms). Default 30s. */
  timeoutMs?: number;
}

export interface AiChatResult {
  text: string;
  raw: unknown;
  usageTokens: number;
  estUsd: number;
}

/** The monthly AI budget for the app is already spent — call refused. */
export class AiBudgetExceededError extends Error {}
/** No API key could be resolved. */
export class AiConfigError extends Error {}
/** The provider returned a non-2xx / unusable response. */
export class AiRequestError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

@Injectable()
export class AiClient {
  /** DNS seam for the SSRF guard (specs inject a fake — never dial DNS). */
  hostResolver: HostResolver = defaultHostResolver;
  /** Fetch seam (specs inject a fake — never hits the network). */
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;

  constructor(
    @Inject(AI_USAGE_TRACKER) private readonly usage: AiUsageTracker,
    @Optional() private readonly secrets?: SecretsStore,
  ) {}

  async chat(input: AiChatRequestInput): Promise<AiChatResult> {
    const apiKey = await this.resolveKey(input);
    if (!apiKey) {
      throw new AiConfigError('no AI API key configured (ai_api_key / secret ref)');
    }

    // Fail closed once the monthly budget is reached.
    const budget = input.budgetUsd ?? 0;
    if (budget > 0) {
      const spent = this.usage.monthlyUsd(input.app, input.appDir);
      if (spent >= budget) {
        throw new AiBudgetExceededError(
          `monthly AI budget reached ($${spent.toFixed(2)} / $${budget.toFixed(2)})`,
        );
      }
    }

    const req = buildChatRequest(input);

    // SSRF guard on the (possibly operator-overridden) base URL.
    await assertSafeEgressUrl(req.url, {
      allowedSchemes: HTTP_SCHEMES,
      label: 'AI endpoint',
      resolveHost: this.hostResolver,
    });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
    );
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(req.url, {
        method: 'POST',
        headers: { ...req.headers, authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new AiRequestError(
        `AI request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Body may carry a provider error message — surface the status only, never
      // the request (which holds the key).
      throw new AiRequestError(`AI provider returned HTTP ${res.status}`);
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new AiRequestError('AI provider returned a non-JSON body');
    }
    const parsed = parseChatResponse(raw);
    const estUsd = estimateUsd(input.model, parsed.usageTokens);
    // Best-effort budget accounting — never let a bookkeeping error fail the box.
    try {
      this.usage.addUsage(input.app, input.appDir, parsed.usageTokens, estUsd);
    } catch {
      /* ignore accounting errors */
    }
    return { text: parsed.text, raw: parsed.raw, usageTokens: parsed.usageTokens, estUsd };
  }

  /** plugin config key first, then the SecretsStore ref (never logs either). */
  private async resolveKey(input: AiChatRequestInput): Promise<string> {
    const direct = (input.apiKey ?? '').trim();
    if (direct) return direct;
    const ref = (input.apiKeyRef ?? '').trim();
    if (ref && this.secrets) {
      const v = await this.secrets.get(ref);
      if (v && v.trim()) return v.trim();
    }
    return '';
  }
}
