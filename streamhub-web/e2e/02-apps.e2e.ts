/**
 * (2) Create app → onboarding wizard appears → skip → app is in the list.
 * Asserts the created app is persisted (visible after a fresh list load and
 * reachable at its detail route) and that the always-skippable onboarding
 * wizard opens right after creation.
 */
import { test, expect, uniqueApp, bearer, apiGet } from './helpers'

test('create app, skip the wizard, see it in the list, open its detail', async ({ page, request }) => {
  const name = uniqueApp('apps')

  await page.goto('/apps')
  await page.getByRole('button', { name: 'New app' }).click()

  const dialog = page.locator('#create-app-form')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').first().fill(name)
  await page.getByRole('button', { name: 'Create app' }).click()

  // The create modal closes and the onboarding wizard opens for the new app.
  await expect(page.locator('#create-app-form')).toHaveCount(0)
  const wizard = page.getByTestId('onboarding-wizard')
  await expect(wizard).toBeVisible()

  // "Omitir" (Skip) is always available and closes the wizard.
  await page.getByTestId('onboarding-skip').click()
  await expect(page.getByTestId('onboarding-wizard')).toHaveCount(0)

  // The new card shows up in the tenant's app grid.
  const card = page.getByRole('heading', { name, exact: true })
  await expect(card).toBeVisible()

  // Persisted server-side: the REST list contains it.
  const token = await bearer(request)
  const apps = await apiGet<Array<{ name: string }>>(request, '/apps', token)
  expect(apps.some((a) => a.name === name)).toBeTruthy()

  // Opening the card navigates to AppDetail (overview tab by default).
  await card.click()
  await expect(page).toHaveURL(new RegExp(`/apps/${name}`))
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
})
