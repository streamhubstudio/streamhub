/**
 * External links surfaced in the dashboard (currently the app footer).
 *
 * REPO_URL lives here as a single exported constant so it is trivially
 * swappable from one place if the canonical repository home ever changes.
 */
export const REPO_URL = 'https://github.com/streamhubstudio/streamhub'

/**
 * Public documentation site.
 *
 * Points at the Laravel marketing site's `/docs` mirror (streamhub-web-laravel,
 * `php artisan docs:sync` — a 1:1 snapshot of this repo's `https://streamhub.studio/docs/`),
 * NOT the `docs.streamhub.studio` subdomain: that subdomain is hosted
 * separately (a hand-curated Astro/Starlight site, repo
 * `digitalhub_com_ar/streamhub-docs`) and does not publish the deep
 * feature/operations pages this dashboard links to — every DocsHint would 404
 * against it. `/docs` on the main domain serves the same comprehensive
 * snapshot and resolves every mapped path below (see docs.ts).
 */
export const DOCS_URL = 'https://streamhub.studio/docs'

/** Release notes — target of the footer version badge. */
export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`
