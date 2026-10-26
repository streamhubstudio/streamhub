/**
 * (4) Studio/plugins — install a worker-less plugin (watermark), ENABLE it,
 * confirm the toggle survives a full page reload, edit a config field, save,
 * reload, and confirm the value persisted (asserted both in the UI and via the
 * REST API).
 */
import { test, expect, uniqueApp, bearer, createApp, switcher, expectSwitch, apiGet } from './helpers'

test('watermark: install → enable → persist → configure → persist', async ({ page, request }) => {
  const app = uniqueApp('plug')
  const token = await bearer(request)
  await createApp(request, token, app)

  const newText = `WM-${Date.now().toString(36)}`

  await page.goto(`/apps/${app}?tab=plugins`)

  const card = () =>
    page
      .locator('div.glass')
      .filter({ has: page.getByRole('heading', { name: 'Watermark', exact: true }) })

  // Install → the lifecycle controls (toggle) replace the Install button.
  await card().getByRole('button', { name: 'Install' }).click()
  await expect(switcher(card())).toBeVisible()
  await expectSwitch(card(), false)

  // Enable → toggle flips on.
  await switcher(card()).click()
  await expectSwitch(card(), true)

  // Full reload → the enabled state persists.
  await page.reload()
  await expect(switcher(card())).toBeVisible()
  await expectSwitch(card(), true)

  // Configure → edit the "Watermark text" field → save.
  await card().getByRole('button', { name: 'Configure' }).click()
  const textField = page.getByLabel('Watermark text')
  await expect(textField).toBeVisible()
  await textField.fill(newText)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // Save success closes the config dialog (ConfigForm.onDone on success).
  await expect(page.getByLabel('Watermark text')).toHaveCount(0)

  // Reload → reopen config → the new value is there.
  await page.reload()
  await card().getByRole('button', { name: 'Configure' }).click()
  await expect(page.getByLabel('Watermark text')).toHaveValue(newText)

  // And it is genuinely persisted server-side.
  const view = await apiGet<{ config?: { text?: string } }>(
    request,
    `/apps/${app}/plugins/watermark`,
    token,
  )
  expect(view.config?.text).toBe(newText)
})
