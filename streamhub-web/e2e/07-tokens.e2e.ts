/**
 * (8) Tokens tab — mint a LiveKit join token (create) and revoke a global API
 * token, asserting the revoke is persisted.
 *
 * The e2e boot seeds a disposable global token named "e2e-disposable" for this
 * spec to revoke (the dashboard has no UI to CREATE an sk_ API token — it only
 * mints join tokens + lists/revokes global ones).
 */
import { test, expect, uniqueApp, bearer, createApp, apiGet } from './helpers'

test('mint a join token and revoke a global token', async ({ page, request }) => {
  const app = uniqueApp('tok')
  const token = await bearer(request)
  await createApp(request, token, app)

  await page.goto(`/apps/${app}?tab=tokens`)

  // Mint: Generate token → a JWT (eyJ…) appears in the result CopyFields.
  await page.getByRole('button', { name: 'Generate token' }).click()
  await expect(page.getByText('Token (JWT)')).toBeVisible()
  const values = await page
    .locator('input[readonly]')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
  expect(values.some((v) => v.startsWith('eyJ'))).toBeTruthy()

  // Revoke the seeded disposable token. window.confirm() gates it.
  page.on('dialog', (d) => d.accept())
  const row = page.getByRole('row', { name: /e2e-disposable/ })
  await expect(row).toBeVisible()
  const revokeBtn = row.getByRole('button', { name: 'Revoke' })

  if (await revokeBtn.isEnabled()) {
    await revokeBtn.click()
    // Row status flips to "revoked" and the button disables.
    await expect(row.getByText('revoked')).toBeVisible()
  }

  // Persisted server-side: the API reports the token revoked.
  const tokens = await apiGet<Array<{ name: string; revoked: boolean }>>(
    request,
    '/tokens',
    token,
  )
  const disposable = tokens.find((t) => t.name === 'e2e-disposable')
  expect(disposable?.revoked).toBe(true)
})
