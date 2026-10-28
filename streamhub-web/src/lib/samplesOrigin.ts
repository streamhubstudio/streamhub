/**
 * Where the per-app sample pages live (pure; tested with node:test).
 *
 * With STREAMHUB_SAMPLES_URL the core serves `/samples/*` only on a dedicated
 * origin (e.g. https://samples.streamhub.studio) and GET /auth/config reports
 * it as `samplesUrl`; without it samples share the dashboard's origin. Every
 * sample link, embed snippet and preview iframe the SPA builds goes through
 * here so it points at the right origin.
 */

/** The samples origin: `samplesUrl` from /auth/config, else the page origin. */
export function samplesOrigin(samplesUrl: string | null | undefined, pageOrigin: string): string {
  const s = (samplesUrl ?? '').trim().replace(/\/+$/, '')
  return s || pageOrigin.replace(/\/+$/, '')
}

/** True when samples are served from an origin other than the dashboard's. */
export function samplesIsolated(samplesUrl: string | null | undefined, pageOrigin: string): boolean {
  const s = (samplesUrl ?? '').trim().replace(/\/+$/, '')
  return s !== '' && s.toLowerCase() !== pageOrigin.replace(/\/+$/, '').toLowerCase()
}

/** `<origin>/samples/<app>/<file>`. */
export function sampleUrl(origin: string, app: string, file: string): string {
  return `${origin}/samples/${encodeURIComponent(app)}/${encodeURIComponent(file)}`
}

/**
 * The preview iframe's sandbox. On the dashboard's own origin it must stay
 * opaque (no `allow-same-origin`): an edited sample is arbitrary JS and would
 * otherwise read the dashboard's localStorage (JWT). On a separate samples
 * origin `allow-same-origin` only grants that origin, so camera/mic work in
 * the preview too.
 */
export function samplePreviewSandbox(isolated: boolean): string {
  const base = 'allow-scripts allow-forms allow-popups allow-modals allow-presentation'
  return isolated ? `${base} allow-same-origin` : base
}
