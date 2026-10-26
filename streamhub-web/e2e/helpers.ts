/**
 * Shared e2e helpers + a `test` fixture that records browser-side errors.
 *
 * The `errors` fixture attaches console-error and pageerror listeners for the
 * whole test and logs a one-line summary at teardown, so the run output doubles
 * as an audit trail (real JS crashes vs benign network noise from an absent
 * Redis/LiveKit).
 */
import { readFileSync } from 'node:fs'
import { test as base, expect, type APIRequestContext, type Locator } from '@playwright/test'

export { expect }

export const ADMIN = { user: 'admin', password: 'admin123' } as const

export const TOKEN_FILE = 'e2e/.auth/token.txt'

/** Unique-per-run app slug (lowercase, valid against the create-app SLUG_RE). */
export function uniqueApp(prefix = 'e2e'): string {
  const rand = Math.random().toString(36).slice(2, 7)
  return `${prefix}-${Date.now().toString(36)}-${rand}`.toLowerCase()
}

/**
 * Admin bearer for asserting persisted state. Reuses the token global-setup
 * captured (written to TOKEN_FILE) so the suite doesn't burn the /auth/login
 * rate-limit budget (10 / 15 min per IP); falls back to a fresh login.
 */
export async function bearer(request: APIRequestContext): Promise<string> {
  try {
    const cached = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (cached) return cached
  } catch {
    /* no cached token — fall through to a live login */
  }
  const res = await request.post('/api/v1/auth/login', { data: ADMIN })
  expect(res.ok(), 'admin login for API assertions').toBeTruthy()
  const body = await res.json()
  return body.data.token as string
}

/** GET an enveloped API resource with the admin bearer, returning `data`. */
export async function apiGet<T = unknown>(
  request: APIRequestContext,
  path: string,
  token: string,
): Promise<T> {
  const res = await request.get(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok(), `GET ${path}`).toBeTruthy()
  const body = await res.json()
  return (body?.data ?? body) as T
}

/** POST an enveloped API resource with the admin bearer, returning `data`. */
export async function apiPost<T = unknown>(
  request: APIRequestContext,
  path: string,
  token: string,
  data?: unknown,
): Promise<T> {
  const res = await request.post(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: data ?? {},
  })
  expect(res.ok(), `POST ${path} (${res.status()})`).toBeTruthy()
  const body = await res.json()
  return (body?.data ?? body) as T
}

/** Create a tenant app via the API (test setup shortcut). */
export async function createApp(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<void> {
  await apiPost(request, '/apps', token, { name })
}

/** Install a plugin into an app via the API (test setup shortcut). */
export async function installPlugin(
  request: APIRequestContext,
  token: string,
  app: string,
  id: string,
): Promise<void> {
  await apiPost(request, `/apps/${app}/plugins/${id}/install`, token)
}

/** The Elstar Switcher renders a <label.switcher> whose state is a CSS class. */
export function switcher(scope: Locator): Locator {
  return scope.locator('label.switcher').first()
}

/** Assert a Switcher is on/off (controlled Switchers don't set input.checked). */
export async function expectSwitch(scope: Locator, on: boolean): Promise<void> {
  const label = switcher(scope)
  if (on) await expect(label).toHaveClass(/switcher-checked/)
  else await expect(label).not.toHaveClass(/switcher-checked/)
}

export const test = base.extend<{ errors: { console: string[]; page: string[] } }>({
  // `provide` is Playwright's fixture-value callback (positional). It is NOT the
  // React `use` hook — named `provide` so the rules-of-hooks lint doesn't trip.
  errors: async ({ page }, provide, testInfo) => {
    const errors = { console: [] as string[], page: [] as string[] }
    page.on('console', (m) => {
      if (m.type() === 'error') errors.console.push(m.text())
    })
    page.on('pageerror', (e) => errors.page.push(e.message))
    await provide(errors)
    if (errors.page.length) {
      console.log(`[PAGEERROR] ${testInfo.title} :: ${errors.page.join(' | ')}`)
    }
    if (errors.console.length) {
      console.log(
        `[CONSOLE-ERROR] ${testInfo.title} :: ${errors.console.slice(0, 6).join(' | ')}`,
      )
    }
  },
})
