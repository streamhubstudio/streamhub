/**
 * (5) Install a Studio App (streamflow) → its full page renders.
 * (6) occupancy app installs → its Studio App page + sections render.
 *
 * Studio Apps open as their own page at /apps/:app/studio/:id. We install via
 * the API (setup) and assert the page renders the app header + its primary
 * surface + the secondary tabs (Overview/Settings/Logs), with the Settings tab
 * showing the generic config form.
 */
import { test, expect, uniqueApp, bearer, createApp, installPlugin } from './helpers'

test('streamflow Studio App page renders', async ({ page, request }) => {
  const app = uniqueApp('studio')
  const token = await bearer(request)
  await createApp(request, token, app)
  await installPlugin(request, token, app, 'streamflow')

  await page.goto(`/apps/${app}/studio/streamflow`)

  // Not the "not installed" empty state — the real app header shows its name.
  await expect(
    page.getByRole('heading', { level: 1, name: /Streamflow/i }),
  ).toBeVisible()
  // Primary surface + secondary tabs render.
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible()
})

test('streamflow deep link activates the addressed section', async ({ page, request }) => {
  const app = uniqueApp('deep')
  const token = await bearer(request)
  await createApp(request, token, app)
  await installPlugin(request, token, app, 'streamflow')

  // Direct navigation to a section URL → that section is the active one.
  await page.goto(`/apps/${app}/studio/streamflow/runs`)
  await expect(
    page.getByRole('heading', { level: 1, name: /Streamflow/i }),
  ).toBeVisible()
  await expect(page.getByTestId('section-runs')).toHaveClass(/bg-sky2/)
  await expect(page.getByTestId('section-workflows')).not.toHaveClass(/bg-sky2/)

  // The section-less URL stays valid and defaults to the first section.
  await page.goto(`/apps/${app}/studio/streamflow`)
  await expect(page.getByTestId('section-workflows')).toHaveClass(/bg-sky2/)

  // An unknown section redirects to the default (no crash) — workflows active.
  await page.goto(`/apps/${app}/studio/streamflow/does-not-exist`)
  await expect(page.getByTestId('section-workflows')).toHaveClass(/bg-sky2/)
  await expect(page).toHaveURL(new RegExp(`/apps/${app}/studio/streamflow/workflows$`))
})

test('occupancy Studio App page + config surface render', async ({ page, request }) => {
  const app = uniqueApp('occ')
  const token = await bearer(request)
  await createApp(request, token, app)
  await installPlugin(request, token, app, 'occupancy')

  await page.goto(`/apps/${app}/studio/occupancy`)

  await expect(
    page.getByRole('heading', { level: 1, name: /Occupancy/i }),
  ).toBeVisible()
  // The Settings tab hosts the generic config form (a Save button proves the
  // typed schema rendered its controls).
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
})
