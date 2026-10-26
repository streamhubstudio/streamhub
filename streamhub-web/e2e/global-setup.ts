/**
 * Global setup — authenticate once via the real break-glass admin login form
 * and persist the storage state so the authenticated specs start logged in.
 * Doing it through the UI (not a hand-written token) guarantees whatever the
 * app persists is exactly what the specs run against.
 */
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { BASE_URL } from '../playwright.config'
import { ADMIN, TOKEN_FILE } from './helpers'

const AUTH_FILE = 'e2e/.auth/state.json'

export default async function globalSetup(): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage({ baseURL: BASE_URL })
  await page.goto('/login?admin=1')
  await page.locator('input[autocomplete="username"]').fill(ADMIN.user)
  await page.locator('input[autocomplete="current-password"]').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // Landed on the dashboard shell (sidebar nav present) → authenticated.
  await page.getByRole('navigation').getByRole('link', { name: 'Apps' }).waitFor()
  await page.context().storageState({ path: AUTH_FILE })
  // Cache the JWT so specs assert API state without re-hitting rate-limited login.
  const token = await page.evaluate(() => localStorage.getItem('streamhub.token'))
  writeFileSync(TOKEN_FILE, token ?? '')
  await browser.close()
}
