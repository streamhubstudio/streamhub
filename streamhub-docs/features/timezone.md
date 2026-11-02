# Per-app timezone (owner item 11)

## What it does

Each app gets an optional `timezone:` config key (an IANA zone name, e.g.
`America/Argentina/Buenos_Aires`). Empty (the default) = server/host local
time — the pre-existing behaviour, unchanged for every app that doesn't set
one.

It's used two ways:

- **Dashboard UI** — every app-scoped timestamp (logs, streams' started-at,
  the Tablero events feed, VODs, config backups, tokens' last-used) renders in
  the app's configured timezone instead of the viewing operator's own browser
  timezone, so two admins on two machines/timezones see the SAME wall-clock
  for that app's events. Non-app screens (the global Logs page, Audit log,
  Network security, OS tuning, Security posture, Account sessions) are
  unaffected — they keep local time, since they aren't scoped to one app.
- **Backend default for timezone-flavoured plugin/schedule config** — an
  explicit plugin-level timezone always wins; the app's timezone is only the
  DEFAULT when a plugin leaves its own timezone field empty. Implemented at the
  framework level via `PluginWorkerContext.appTimezone` (see
  `streamhub-core-go/internal/plugins/contract.go`) — the core hands
  every worker-based plugin the app's resolved timezone alongside its own
  config, so a plugin with a timezone-aware schedule (e.g. an arm/disarm
  window) can read `ctx.appTimezone` as its fallback. The in-tree
  `scheduled-live` module's per-event `timezone` field (display/round-trip
  only, no server-side timezone math — see its own doc comments) follows the
  same precedence: an omitted/empty event timezone defaults to the app's
  configured one, falling back further to `UTC` when the app has none either.

## Configuration

Config.yaml (top-level, alongside `room_prefix`) — full reference in
[config-reference.md](../config-reference.md#top-level):

```yaml
timezone: ""   # IANA zone name, e.g. America/Argentina/Buenos_Aires; empty = server default
```

API: `PATCH /apps/{name} { timezone }` (same route that edits `displayName`/
`roomPrefix`). Validated server-side against the runtime's IANA zone list
(the ICU name set — canonical names, zoneinfo links, any letter case, UTC-offset
zones — embedded in the binary so the answer doesn't depend on the host's zoneinfo;
see `streamhub-core-go/internal/platform/timezone`); an invalid
value is rejected with 400. `GET /apps/{app}/config` surfaces the resolved
value (empty string when unset). The dashboard exposes a searchable selector
in **App → Config → Timezone** (a text input backed by a `<datalist>` of
every IANA zone the browser knows, with a live "right now there" preview and
a one-click "use server default" clear button).

## Precedence (document per the owner brief)

```
explicit plugin-level timezone  >  app's config.yaml `timezone`  >  UTC / server local
```

This is a framework-level contract addition, not a change to any specific
plugin: `PluginWorkerContext.appTimezone` is optional and additive, so an
existing worker plugin that never reads it is completely unaffected. The 4
decoupled Studio Apps with arm/disarm-style schedules (`presence`,
`perimeter`) live in their own repos outside this monorepo — adopting
`ctx.appTimezone` as their schedule default is a change to make in *their*
codebases; this repo only guarantees the value is available to read.

## Shared formatting util

`streamhub-web/src/lib/datetime.ts`'s `formatDateTime(input, timeZone?)` now
takes an optional IANA timezone as its 2nd argument (omitted/empty = unchanged
local-time behaviour). The app's resolved timezone is threaded through
app-scoped screens via `AppTimezoneProvider`/`useAppTimezone()`
(`streamhub-web/src/lib/appTimezone.tsx`, wrapping `AppDetail`'s tab-content
region) — deliberately placed in `lib/` rather than `pages/AppDetail/` so
app-scoped **plugins** (e.g. Streamflow's runs view) can consume it too
without crossing the plugins↔pages import boundary.

## See also

- [config-reference.md](../config-reference.md#top-level) — the `timezone` config key.
- `streamhub-core-go/internal/platform/timezone/timezone.go` — IANA validation + listing.
- `streamhub-web/src/lib/datetime.ts` / `streamhub-web/src/lib/appTimezone.tsx` — frontend rendering + context.
- `streamhub-core-go/internal/plugins/contract.go` — the worker context's `AppTimezone`.
- `streamhub-core-go/internal/scheduledlive/` — the in-tree precedence implementation.
