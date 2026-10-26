/**
 * (11) Onboarding wizard — the "apply" path.
 *
 * Create an app through the UI, choose Surveillance, select the occupancy
 * vision model, and Finalizar. Asserts:
 *  - the occupancy plugin was genuinely installed (REST API), and
 *  - onboarding is persisted as completed, so re-opening the app does NOT
 *    re-prompt (the setup-wizard banner is gone).
 *
 * Plugin install is a pure DB write (no worker started), so this needs no live
 * LiveKit — the same reason 04-plugins can install watermark offline.
 */
import { test, expect, uniqueApp, bearer, apiGet } from './helpers'

test('surveillance → install occupancy → finalize persists and does not re-prompt', async ({
  page,
  request,
}) => {
  const name = uniqueApp('onb')

  await page.goto('/apps')
  await page.getByRole('button', { name: 'New app' }).click()
  await page.locator('#create-app-form input').first().fill(name)
  await page.getByRole('button', { name: 'Create app' }).click()

  const wizard = page.getByTestId('onboarding-wizard')
  await expect(wizard).toBeVisible()

  // Step 1 — purpose: Surveillance/CCTV.
  await page.getByTestId('purpose-surveillance').click()
  await page.getByTestId('onboarding-next').click() // → recording
  await page.getByTestId('onboarding-next').click() // → viewers
  await page.getByTestId('onboarding-next').click() // → vision

  // Select the occupancy model, then Finalizar from here.
  await page.getByTestId('vision-occupancy').click()
  await page.getByTestId('onboarding-finish').click()

  // The wizard applies the plan and lands on the closing screen.
  await expect(page.getByTestId('onboarding-close')).toBeVisible()
  await page.getByTestId('onboarding-close').click()
  await expect(page.getByTestId('onboarding-wizard')).toHaveCount(0)

  // The occupancy plugin was genuinely installed server-side.
  const token = await bearer(request)
  const view = await apiGet<{ installed?: boolean }>(
    request,
    `/apps/${name}/plugins/occupancy`,
    token,
  )
  expect(view.installed).toBeTruthy()

  // Re-opening the app does NOT re-prompt: onboarding is completed, so the
  // setup-wizard banner is absent.
  await page.goto(`/apps/${name}`)
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByTestId('onboarding-wizard')).toHaveCount(0)
  await expect(page.getByTestId('setup-wizard-cta')).toHaveCount(0)
})
