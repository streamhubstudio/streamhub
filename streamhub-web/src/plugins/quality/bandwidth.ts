/**
 * Client-side bandwidth / latency runner for the Quality panel.
 *
 * This is the IMPURE shell (it touches `fetch`, `performance.now`, timers) that
 * feeds raw numbers into the pure classifiers in health.logic.ts. Kept out of
 * the component so the component stays declarative, and out of health.logic.ts
 * so that module stays node:test-able without a network.
 *
 * How each metric is really obtained (and its honest limits) — see the plugin's
 * README-in-code here so callers know what they're looking at:
 *
 *  • DOWNLOAD  — re-fetch a same-origin asset (cache-busted) and read the body
 *    stream, summing bytes until a byte budget or a time cap. mbps = bits/seconds
 *    over the WHOLE run. A per-chunk delta also yields a live reception bitrate
 *    (the getStats() analogue). Limit: throughput is capped by the asset+server;
 *    point `download_url` at a large file for steadier numbers.
 *
 *  • UPLOAD    — POST a random blob and time until the response resolves. Needs a
 *    server that READS the body, so it is OPT-IN via `upload_url`. There is no
 *    browser-only way to measure upload without such an endpoint; when the URL is
 *    blank we skip the leg and report it as not-measured.
 *
 *  • LATENCY   — time several tiny GETs to a same-origin endpoint (default the
 *    public /api/v1/health) → RTT (median) + jitter (mean abs consecutive diff).
 *    Packet loss is NOT observable over HTTP, so it stays undefined here.
 */
import {
  bytesToMbps,
  deltaKbps,
  jitterFrom,
  mean,
} from './health.logic.ts'

/** Append a cache-buster so intermediary/browser caches never short-circuit. */
function bust(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_shq=${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export interface DownloadResult {
  bytes: number
  ms: number
  mbps: number
  /** Peak instantaneous reception bitrate seen across chunks (kbps). */
  peakKbps: number
}

/**
 * Measure download throughput by pulling `targetBytes` from `url` (re-fetched as
 * needed), streaming the body so we can sample a live reception bitrate.
 * `onProgress` is called with cumulative bytes for a UI meter.
 */
export async function runDownloadTest(
  url: string,
  targetBytes: number,
  opts: {
    signal?: AbortSignal
    maxMs?: number
    onProgress?: (bytes: number, kbps: number) => void
  } = {},
): Promise<DownloadResult> {
  const maxMs = opts.maxMs ?? 12_000
  const start = now()
  let bytes = 0
  let peakKbps = 0
  let lastBytes = 0
  let lastMs = 0

  while (bytes < targetBytes && now() - start < maxMs) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const res = await fetch(bust(url), { cache: 'no-store', signal: opts.signal })
    if (!res.ok || !res.body) {
      throw new Error(`download failed: HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value?.byteLength ?? 0
      const t = now() - start
      const inst = deltaKbps(lastBytes, lastMs, bytes, t)
      if (inst > peakKbps) peakKbps = inst
      lastBytes = bytes
      lastMs = t
      opts.onProgress?.(bytes, inst)
      if (bytes >= targetBytes || now() - start >= maxMs) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  }

  const ms = now() - start
  return { bytes, ms, mbps: bytesToMbps(bytes, ms), peakKbps }
}

export interface UploadResult {
  bytes: number
  ms: number
  mbps: number
}

/** Deterministic-ish random payload; avoids the browser zero-compressing it. */
function randomPayload(sizeBytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(Math.max(0, Math.floor(sizeBytes)))
  const view = new Uint8Array(buffer)
  // crypto.getRandomValues caps at 65536 bytes/call.
  const g =
    typeof crypto !== 'undefined' && 'getRandomValues' in crypto ? crypto : null
  const CHUNK = 65536
  for (let off = 0; off < view.length; off += CHUNK) {
    const slice = view.subarray(off, Math.min(off + CHUNK, view.length))
    if (g) g.getRandomValues(slice)
    else for (let i = 0; i < slice.length; i++) slice[i] = (off + i) & 0xff
  }
  return buffer
}

/**
 * Measure upload throughput by POSTing a `sizeBytes` random blob to `url` and
 * timing until the response resolves. Returns null when `url` is blank (the
 * upload leg is opt-in — see the file header). Throws on a failed request.
 */
export async function runUploadTest(
  url: string,
  sizeBytes: number,
  opts: { signal?: AbortSignal } = {},
): Promise<UploadResult | null> {
  const target = url.trim()
  if (!target) return null
  const payload = randomPayload(sizeBytes)
  const blob = new Blob([payload], { type: 'application/octet-stream' })
  const start = now()
  const res = await fetch(target, {
    method: 'POST',
    body: blob,
    cache: 'no-store',
    signal: opts.signal,
  })
  const ms = now() - start
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`)
  // Drain any response body so the timing reflects a completed round-trip.
  await res.arrayBuffer().catch(() => undefined)
  return { bytes: payload.byteLength, ms, mbps: bytesToMbps(payload.byteLength, ms) }
}

export interface LatencyResult {
  rttMs: number
  jitterMs: number
  samples: number[]
}

/**
 * Measure round-trip latency + jitter by timing `count` tiny GETs to `pingUrl`
 * (default the public health endpoint). RTT is the mean of the samples; jitter
 * is the mean absolute consecutive difference. Individual failed pings are
 * skipped rather than aborting the whole measurement.
 */
export async function measureLatency(
  pingUrl: string,
  count = 5,
  opts: { signal?: AbortSignal } = {},
): Promise<LatencyResult> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const t0 = now()
    try {
      await fetch(bust(pingUrl), { cache: 'no-store', signal: opts.signal })
      samples.push(now() - t0)
    } catch (err) {
      if (opts.signal?.aborted) throw err
      // transient failure — skip this sample
    }
  }
  return { rttMs: mean(samples), jitterMs: jitterFrom(samples), samples }
}
