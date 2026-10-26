/**
 * Minimal OpenAI speech-to-text client for the transcription plugin's
 * `provider: 'openai'` fallback (POST /v1/audio/transcriptions, multipart).
 *
 *  - `whisper-1` supports `response_format: verbose_json` → per-segment
 *    timestamps (what the SRT builder needs) + detected language.
 *  - `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` only return plain
 *    `json` (no segment timing) — the caller synthesizes one full-length
 *    segment; whisper-1 is therefore the recommended OpenAI model for SRT.
 *
 * `fetchImpl` is injectable so unit tests never touch the network, and the
 * API key is never included in thrown error messages.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface OpenAiTranscribeOptions {
  apiKey: string;
  /** whisper-1 | gpt-4o-transcribe | gpt-4o-mini-transcribe. */
  model: string;
  /** Local audio file (mp3) to upload. */
  filePath: string;
  /** Filename hint for the multipart part (defaults to basename). */
  fileName?: string;
  /** ISO language code; '' or 'auto' lets the model detect it. */
  language?: string;
  /** API base (default https://api.openai.com/v1) — override for proxies. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface OpenAiTranscription {
  text: string;
  language: string | null;
  /** Timed segments (whisper-1 verbose_json only; null otherwise). */
  segments: { start: number; end: number; text: string }[] | null;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Whether the model supports `verbose_json` (segment timestamps). */
export function supportsVerboseJson(model: string): boolean {
  return model.trim().toLowerCase().startsWith('whisper');
}

interface VerboseJsonResponse {
  text?: string;
  language?: string;
  segments?: { start?: number; end?: number; text?: string }[];
}

/** Transcribe one audio file via the OpenAI API. Throws on any failure. */
export async function transcribeViaOpenAi(
  opts: OpenAiTranscribeOptions,
): Promise<OpenAiTranscription> {
  if (!opts.apiKey || !opts.apiKey.trim()) {
    throw new Error('OpenAI API key is not configured');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const verbose = supportsVerboseJson(opts.model);

  const buf = await fs.promises.readFile(opts.filePath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' }),
    opts.fileName ?? path.basename(opts.filePath),
  );
  form.append('model', opts.model);
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  const lang = (opts.language ?? '').trim().toLowerCase();
  if (lang && lang !== 'auto') form.append('language', lang);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetchImpl(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      `OpenAI transcription request failed: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* body unreadable */
    }
    throw new Error(
      `OpenAI transcription failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    );
  }

  const body = (await res.json()) as VerboseJsonResponse;
  const segments = Array.isArray(body.segments)
    ? body.segments.map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text ?? '').trim(),
      }))
    : null;
  return {
    text: String(body.text ?? ''),
    language: body.language ? String(body.language) : null,
    segments,
  };
}
