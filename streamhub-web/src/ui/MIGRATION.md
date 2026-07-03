# StreamHub UI — Elstar re-skin (MIGRATION)

The `@/ui` folder is the Elstar design system, **ported and re-skinned to the
StreamHub brand**. It is a *re-skin*, not a rewrite: we kept Elstar's component
structure/behaviour and mapped its theming onto StreamHub's existing tokens.

## What to use

```ts
import {
  Card, Button, Tabs, Table, Input, InputGroup, FormItem, FormContainer,
  Dialog, Drawer, Dropdown, Menu, MenuItem, Avatar, Badge, Tag,
  Notification, toast, Switcher, Segment, Skeleton, Spinner, Pagination,
  Alert, Tooltip, Steps, Select, ScrollBar,
} from '@/ui'
```

Every component is a default-exported React component (some are compound, e.g.
`Dropdown.Item`, `Dropdown.Menu`, `Table.Thead/Tbody/Tr/Th/Td`, `Menu.Item`,
`Tabs.TabList/TabNav/TabContent`, `Steps.Item`). Types are exported alongside
(`ButtonProps`, `CardProps`, …).

Auth screens use the ported cover layout:

```tsx
import { Cover } from '@/layout/AuthLayout'
<Cover content={<Heading/>} panelTitle="…" panelText="…"><SignInForm/></Cover>
```

## The re-skin pattern (READ THIS before re-skinning a page)

1. **Swap raw markup for components.** Replace ad-hoc `<div class="glass">` cards
   with `<Card>`, hand-rolled buttons with `<Button variant="solid">`, tables
   with `<Table>`, tabs with `<Tabs>`, etc. Do **not** touch the page's logic,
   data hooks (react-query), router, plugins or auth.
2. **Accent = `primary` (brand).** Anything accent-coloured resolves to the
   brand blue automatically:
   - `<Button variant="solid">` → brand `#2f7bff`.
   - In your own markup use `text-primary-500`, `bg-primary-500/10`,
     `ring-primary-500/30`, `border-primary-500`, etc. (full `primary-50…950`
     scale is defined in `src/index.css`).
3. **Light/dark is automatic.** It's driven by the `.dark` class on `<html>`
   (StreamHub `ThemeProvider` + the no-flash script). Component internals use
   Tailwind's `dark:` variant; you don't wire anything up. `<Select/>` also
   reads the resolved theme via `StreamHubConfigProvider` (already mounted in
   `main.tsx`).
4. **Surfaces.** Ported components use Tailwind's default `gray-*` scale for
   their own surfaces (the Elstar look). For *page-level* chrome prefer the
   StreamHub semantic tokens (`bg-surface`, `bg-surface-raised`, `bg-sidebar`,
   `border-border`, `text-fg`, `text-fg-muted`, `text-fg-subtle`,
   `success/warn/danger/info`) so it matches the shell.
5. **Common props:** `size` = `xs|sm|md|lg`; `variant` on `Button` =
   `solid|twoTone|plain|default`; `shape` = `round|circle|none`. `color`
   overrides per-instance (e.g. `<Button color="red-500">`).

### Toasts / notifications
```ts
import { toast, Notification } from '@/ui'
toast.push(<Notification title="Saved" type="success">…</Notification>)
```

### Dialog / Drawer
Pass `ariaHideApp={false}` (react-modal) unless you call
`Modal.setAppElement('#root')` at boot. See the mobile nav `Drawer` in
`src/layout/AppLayout.tsx` for a worked example.

## Theme mapping (Elstar → StreamHub)

| Elstar concept                          | StreamHub mapping |
|-----------------------------------------|-------------------|
| `ConfigProvider.themeColor`             | fixed to `'primary'` (brand, no theme switcher) |
| `primaryColorLevel`                     | `500` (`bg-primary-500` = `#2f7bff`) |
| dynamic `bg-${themeColor}-${level}`     | `primary-*` scale in `@theme` + `@source inline(...)` safelist in `src/index.css` |
| `mode: 'light' | 'dark'`                | synced from `ThemeProvider` via `StreamHubConfigProvider` |
| Elstar `.dark` (class strategy)         | kept — `@custom-variant dark (&:where(.dark, .dark *))` |
| Elstar component CSS (`_button.css`, …) | ported to `src/ui/ui.css` (v4-adapted: `@screen`→`@media`, `!x`→`x!`), imported from `src/index.css` |
| `ltr:` / `rtl:` variants                | `@custom-variant ltr/rtl` in `src/index.css`; app is LTR (`<html dir="ltr">`) |
| font Inter                              | unchanged (`--font-sans`, self-hosted variable Inter) |
| logo                                    | unchanged solid `/logo-dark.svg` + `/logo-light.svg` via `@/components/Logo` |

## What was intentionally NOT migrated

- **Redux / Formik / the Elstar ConfigProvider theme-switcher UI.** We keep a
  fixed brand config; `Form`/`Input` are used controlled by React state (or the
  page's existing form logic), not Formik.
- Elstar's `Calendar/DatePicker/RangeCalendar/TimeInput/Timeline/Upload/Progress/
  Checkbox/Radio` (not needed yet; `dayjs` etc. not pulled in).
- No changes to `streamhub-core`, the data-layer (`@/api`, react-query),
  the plugin system (`@/plugins`, `PluginSlot`) or auth (magic-link/reset/
  break-glass).

## Build / test gates

- `npm run build` (tsc -b + vite) — green.
- `npm test` (node:test, 58 tests) — green.
- Vendored files were adapted for the app's strict TS (React 19 refs,
  `verbatimModuleSyntax`, erasable syntax) — app tsconfig strictness was **not**
  weakened.
