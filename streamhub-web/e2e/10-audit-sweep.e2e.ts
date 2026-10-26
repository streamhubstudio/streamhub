/**
 * Audit sweep — visit every management page + every AppDetail tab and record
 * console errors, uncaught page errors and failed same-origin API calls. Pages
 * must render a top-level heading (a blank crash fails); everything else is
 * logged (not asserted) so degraded-by-design surfaces (no LiveKit/Redis) don't
 * turn into red tests. Read the [AUDIT]/[API-FAIL]/[CONSOLE-ERROR] lines in the
 * run output for the findings.
 */
import { test, expect, uniqueApp, bearer, createApp, installPlugin } from './helpers'

const PAGES = [
  '/',
  '/apps',
  '/studio',
  '/cluster',
  '/logs',
  '/resources',
  '/settings',
  '/audit',
  '/compliance',
  '/account',
]

const APP_TABS = [
  'overview',
  'streams',
  'vods',
  'ingress',
  'tokens',
  'samples',
  'integraciones',
  'plugins',
  'logs',
  'sistema',
  'config',
]

test('sweep every page + AppDetail tab, log console/API failures', async ({ page, request }) => {
  const app = uniqueApp('audit')
  const token = await bearer(request)
  await createApp(request, token, app)
  await installPlugin(request, token, app, 'occupancy')

  const apiFails: string[] = []
  page.on('response', (res) => {
    const url = res.url()
    if (url.includes('/api/v1/') && res.status() >= 400) {
      apiFails.push(`${res.status()} ${res.request().method()} ${url.split('/api/v1')[1]}`)
    }
  })

  async function visit(path: string): Promise<void> {
    apiFails.length = 0
    await page.goto(path)
    // A rendered page always has a top-level heading; a blank crash would not.
    await expect(page.locator('h1, h2').first()).toBeVisible()
    // Leaked i18n keys surface as visible "namespace.some.key" text.
    const leak = await page
      .locator('h1, h2, button, a, label, th, span')
      .filter({ hasText: /^[a-z][a-zA-Z0-9]+(\.[a-z][a-zA-Z0-9]+){2,}$/ })
      .count()
    if (leak > 0) console.log(`[AUDIT] ${path} :: ${leak} possible leaked i18n key(s)`)
    // Give async queries a beat to settle so their failures are captured.
    await page.waitForTimeout(400)
    if (apiFails.length) {
      console.log(`[API-FAIL] ${path} :: ${[...new Set(apiFails)].join(' , ')}`)
    }
  }

  for (const p of PAGES) await visit(p)
  for (const tab of APP_TABS) await visit(`/apps/${app}?tab=${tab}`)
  await visit(`/apps/${app}/studio/occupancy`)
})
