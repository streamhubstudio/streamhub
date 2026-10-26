/**
 * (1) Login — bad creds rejected, good creds land on the dashboard.
 * Runs WITHOUT the shared authenticated storage state so it drives the real
 * break-glass admin form.
 */
import { test, expect, ADMIN } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('login', () => {
  test('rejects bad credentials and stays on /login', async ({ page }) => {
    await page.goto('/login?admin=1')
    await page.locator('input[autocomplete="username"]').fill(ADMIN.user)
    await page.locator('input[autocomplete="current-password"]').fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    // Backend answers 401 → the form shows the invalid-credentials alert and the
    // URL never leaves /login.
    await expect(page.getByText('Invalid credentials.')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('good credentials land on the dashboard', async ({ page }) => {
    await page.goto('/login?admin=1')
    await page.locator('input[autocomplete="username"]').fill(ADMIN.user)
    await page.locator('input[autocomplete="current-password"]').fill(ADMIN.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    // Redirected off /login into the authenticated shell (sidebar nav present).
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$|\/$/)
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Apps' })).toBeVisible()
  })
})
