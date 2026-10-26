/**
 * (7) Cluster page — the registry renders, the Edge sub-tab renders, and the
 * per-node weight editor is present WHEN a node exists.
 *
 * On a bare core clustering is OFF (registry shows the enable-guidance) and
 * /edge/nodes is empty, so the weight editor legitimately has nothing to bind
 * to — the test asserts the empty state and only checks the weight input if a
 * node card is present.
 */
import { test, expect } from './helpers'

test('cluster registry + edge tabs render', async ({ page }) => {
  await page.goto('/cluster')

  // Registry (default tab): the page title + the info block. Clustering is off
  // on a standalone core → the enable-guidance shows.
  await expect(page.getByRole('heading', { level: 1, name: 'Cluster' })).toBeVisible()
  await expect(page.getByText('Clustering is off')).toBeVisible()

  // Switch to the Edge sub-tab.
  await page.getByTestId('cluster-tab-edge').click()
  await expect(page.getByRole('heading', { name: 'Edge nodes' })).toBeVisible()

  const nodeCards = page.locator('[data-testid^="edge-node-"]')
  if ((await nodeCards.count()) > 0) {
    // A node exists → the weighted-policy editor input is present.
    await expect(page.locator('[data-testid^="edge-weight-"]').first()).toBeVisible()
  } else {
    // No edge nodes registered without a cluster/WS peer — documented degradation.
    await expect(
      page.getByText('No nodes registered yet.', { exact: false }),
    ).toBeVisible()
  }
})
