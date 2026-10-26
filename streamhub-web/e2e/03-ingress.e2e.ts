/**
 * (3) Ingress modal — create a PASSTHROUGH ingress and see its rtmp_url + the
 * ptk_ stream key.
 *
 * NOTE: regular (transcoded/WebRTC) ingress needs the LiveKit ingress service
 * and 503s on a bare core — see the SKIPPED test below. Passthrough is a
 * core-internal remux plane; it only works when the operator enables it
 * (STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on), which the e2e boot sets.
 */
import { test, expect, uniqueApp, bearer, createApp } from './helpers'

const PASSTHROUGH = 'Passthrough (remux, no transcode)'

test('create a passthrough ingress → rtmp URL + ptk_ key shown', async ({ page, request }) => {
  const app = uniqueApp('ingress')
  const token = await bearer(request)
  await createApp(request, token, app)

  await page.goto(`/apps/${app}?tab=ingress`)

  // Flip the passthrough (remux) toggle ON, then create the endpoint. The
  // Switcher hides its checkbox and styles the wrapping <label>, so click that.
  const passthroughLabel = page.getByLabel(PASSTHROUGH).locator('xpath=..')
  await passthroughLabel.click()
  await expect(passthroughLabel).toHaveClass(/switcher-checked/)

  await page.getByRole('button', { name: 'Create ingress' }).click()

  // Credentials block: rtmp_url + a ptk_-prefixed stream key. (exact: the field
  // labels also appear as substrings in the help copy below them.)
  await expect(page.getByText('RTMP URL', { exact: true })).toBeVisible()
  await expect(page.getByText('Stream key', { exact: true })).toBeVisible()

  // Controlled inputs set the DOM value property (not the attribute), so read it.
  const values = await page
    .locator('input[readonly]')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
  expect(values.some((v) => v.startsWith('ptk_'))).toBeTruthy()
  expect(values.some((v) => v.startsWith('rtmp://'))).toBeTruthy()
})

test.skip('regular (transcoded) ingress — needs the LiveKit ingress service', () => {
  // On a bare core POST /apps/:app/ingress (non-passthrough) returns 503 because
  // LiveKit's ingress API is unreachable. Covered by unit/integration tests with
  // a mocked LiveKit; cannot be exercised behaviorally here.
})
