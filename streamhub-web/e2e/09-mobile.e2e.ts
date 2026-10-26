/**
 * (10) Mobile viewport (390x844): the hamburger opens the nav drawer, and the
 * Dashboard, AppDetail and Marketplace pages have no horizontal body scroll.
 */
import { test, expect, uniqueApp, bearer, createApp } from './helpers'

test.use({ viewport: { width: 390, height: 844 } })

async function noHorizontalScroll(page: import('@playwright/test').Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement
    return el.scrollWidth - el.clientWidth
  })
  expect(overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(1)
}

test('mobile: no horizontal scroll on key pages + drawer opens', async ({ page, request }) => {
  const app = uniqueApp('mob')
  const token = await bearer(request)
  await createApp(request, token, app)

  // Dashboard
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible()
  await noHorizontalScroll(page)

  // AppDetail
  await page.goto(`/apps/${app}`)
  await expect(page.getByRole('heading', { level: 1, name: app })).toBeVisible()
  await noHorizontalScroll(page)

  // Marketplace (Studio)
  await page.goto('/studio')
  await noHorizontalScroll(page)

  // Hamburger opens the slide-in drawer with the nav links (the desktop sidebar
  // is hidden below lg). Scope to the drawer so the hidden desktop nav doesn't
  // ambiguate the match.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(
    page.locator('.drawer').getByRole('link', { name: 'Apps', exact: true }),
  ).toBeVisible()
})
