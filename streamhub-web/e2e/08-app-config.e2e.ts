/**
 * (9) App settings/config form — change a value in the app's Config tab, save,
 * and verify via the REST API that it actually changed.
 *
 * A freshly-created app ships with adaptive delivery ON (3-layer ladder). We
 * turn it OFF, save, and confirm GET /apps/:app/config reports adaptive:false.
 */
import { test, expect, uniqueApp, bearer, createApp, apiGet } from './helpers'

const ADAPTIVE = 'Adaptive delivery (simulcast)'

test('config tab: toggle adaptive off, save, verify via API', async ({ page, request }) => {
  const app = uniqueApp('cfg')
  const token = await bearer(request)
  await createApp(request, token, app)

  // Sanity: the app starts with adaptive ON.
  const before = await apiGet<{ adaptive?: boolean }>(request, `/apps/${app}/config`, token)
  expect(before.adaptive).toBe(true)

  await page.goto(`/apps/${app}?tab=config`)

  // The Switcher hides its checkbox and styles the wrapping <label>, so target
  // that for both the state assertion and the click.
  const adaptive = page.getByLabel(ADAPTIVE).locator('xpath=..')
  await expect(adaptive).toHaveClass(/switcher-checked/)

  // Turn it OFF and save.
  await adaptive.click()
  await expect(adaptive).not.toHaveClass(/switcher-checked/)
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible()

  // Persisted: the API reports adaptive is now off.
  const after = await apiGet<{ adaptive?: boolean }>(request, `/apps/${app}/config`, token)
  expect(after.adaptive).toBe(false)
})
