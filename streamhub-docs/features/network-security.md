# Network security — in-app IP access control + abuse auto-ban

Defensive, application-level network protection built into streamhub-core
(`src/modules/security/`): a global **IP allow/blocklist** (IPv4 + IPv6, CIDR)
and an **in-app fail2ban** that auto-bans abusive client IPs — enforced by one
early middleware that runs before every guard and route handler.

> **This complements — it does not replace — the reverse proxy and the OS
> firewall.** Caddy/nginx and `ufw`/nftables remain the first line (they stop
> traffic before it consumes a Node connection at all, and they cover the
> non-HTTP ports: RTMP 1935, WHIP 8080, WebRTC UDP). What the in-app layer adds
> is what only the app can know: *which* IPs are failing logins, replaying
> magic links, guessing `sk_` tokens or tripping the rate limiter — and the
> ability for the operator to block/allow ranges from the dashboard without
> shelling into the box.

## The lock-out guarantee

**Loopback and private addresses are ALWAYS permitted and NEVER auto-banned**,
in every mode, regardless of any rule:

- IPv4: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `169.254.0.0/16`
- IPv6: `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), plus IPv4-mapped
  (`::ffff:a.b.c.d`) folded to their v4 range

So the box itself, the Docker healthcheck (`127.0.0.1:3020/api/v1/health`),
`/metrics` scrapes from localhost, and LAN/cluster peers can never be locked
out — even by a `0.0.0.0/0` block rule or `STREAMHUB_IP_ALLOWLIST_ONLY=true`.

## IP access control (rules)

Rules live in the global-DB table `ip_rules` (created idempotently at boot) and
are compiled into memory — the per-request check is an in-memory CIDR match,
no DB access. Managed via the admin API / the **Network security** section of
Server Settings.

**Precedence** (per request):

1. loopback/private → **always allow** (see above)
2. explicit `allow` rule → allow (also shields the IP from ban enforcement)
3. active auto-ban → **429**
4. explicit `block` rule → **403** (in `enforce` mode)
5. `STREAMHUB_IP_ALLOWLIST_ONLY=true` → any public IP with no `allow` rule →
   **403** (in `enforce` mode)
6. default → allow

**Modes** (`STREAMHUB_IP_ACCESS_MODE`):

| Mode | Behaviour |
|---|---|
| `off` (default) | rules are not evaluated (auto-ban still applies if enabled) |
| `log` | would-be blocks are logged (`ip-access would_block …`) and the request is annotated (`req.ipAccess = 'would_block'`), but **never rejected** — use this to trial a rule set |
| `enforce` | blocked → `403 { error: { code: "forbidden" } }` |

Rejections are deliberately generic: a small JSON envelope + a structured log
line. The client never learns *which* rule or ban matched.

## Auto-ban (in-app fail2ban)

`IpReputationService` records **offenses** per client IP into an in-memory
sliding window. Offense kinds wired into the real failure sites:

| Kind | Source |
|---|---|
| `login_failed` | `AuthService.login` — bad password / unknown user / bad TOTP |
| `magic_verify_failed` | `MagicLinkService.verify` — bogus / expired / replayed link |
| `invalid_token` | `AuthService.validate` — presented-but-unknown `sk_` token or forged/expired JWT (a *missing* bearer is not an offense) |
| `rate_limited` | the auth rate limiter's 429 handler (login / magic-link paths) |
| `not_found` | optional 404-storm tracking (`STREAMHUB_AUTOBAN_404_ENABLED`) |

All reporting is **fire-and-forget**: `recordOffense` never throws, so
reputation tracking can never break a request.

**Banning**: `STREAMHUB_AUTOBAN_MAX_OFFENSES` (default 10) offenses within
`STREAMHUB_AUTOBAN_WINDOW_S` (default 300 s) → ban for
`STREAMHUB_AUTOBAN_BASE_TTL_S` (default 900 s). Each **repeat** ban doubles the
TTL (2^level escalation), capped at 7 days. A banned IP gets a generic `429`
on every route. Active bans are persisted to the global-DB table `ip_bans`
(written on ban + refreshed by a periodic sweep) so **bans survive a core
restart**; expired bans are kept 7 days for the "recent" list, then purged.

**Never banned**: loopback/private IPs and IPs matching an explicit `allow`
rule (offenses are still counted so they show up under *Recent offenders*).
**Unban** (API/dashboard) is a clean slate: lifts the ban, clears the offense
window and resets the escalation level.

### Tuning

- Brute-force focus: lower `MAX_OFFENSES` (e.g. 5) and keep the default window.
- Noisy scanners: enable `STREAMHUB_AUTOBAN_404_ENABLED=true` — but only if
  nothing legitimate polls unknown paths (the SPA fallback serves index.html,
  so real 404s come from the API surface).
- Shared/NAT'd client networks: raise `MAX_OFFENSES` or allowlist the range —
  one abusive tenant behind a NAT can otherwise ban the whole office.
- Roll out like AUTHZ: start with everything off → `STREAMHUB_IP_ACCESS_MODE=log`
  \+ `STREAMHUB_AUTOBAN_ENABLED=true`, watch `/security/offenses` and the
  `ip-access` log lines → switch to `enforce`.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_IP_ACCESS_MODE` | `off` | `off` \| `log` \| `enforce` — rule evaluation mode. |
| `STREAMHUB_IP_ALLOWLIST_ONLY` | `false` | Strict allowlist: public IPs without an explicit `allow` rule are rejected (in `enforce`). Loopback/private always pass. |
| `STREAMHUB_AUTOBAN_ENABLED` | `false` | Master switch for offense recording + ban enforcement. |
| `STREAMHUB_AUTOBAN_MAX_OFFENSES` | `10` | Offenses within the window that trigger a ban. |
| `STREAMHUB_AUTOBAN_WINDOW_S` | `300` | Sliding offense window (seconds). |
| `STREAMHUB_AUTOBAN_BASE_TTL_S` | `900` | First-ban duration (seconds); doubles per repeat ban, capped at 7 days. |
| `STREAMHUB_AUTOBAN_404_ENABLED` | `false` | Count 404 responses (from public IPs) as offenses. |

## Admin API (`/api/v1/security/*` — global scope / superadmin only)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/security/status` | mode, allowlist-only flag, auto-ban config, rule/ban/offender counts |
| GET | `/security/ip-rules` | list rules (newest first) |
| POST | `/security/ip-rules` | `{ cidr, action: allow\|block, note? }` — 400 on invalid CIDR/duplicate |
| DELETE | `/security/ip-rules/{id}` | remove a rule (404 unknown) |
| GET | `/security/bans` | `{ active, recent }` bans |
| POST | `/security/bans/{ip}/unban` | lift a ban (clean slate; 404 when not banned) |
| GET | `/security/offenses` | recent offenders: per-IP counts + kind breakdown |

Every endpoint uses the same global-scope gate as `/cluster` and `/system`
(app-scoped principals get 403). Rule/ban mutations take effect immediately
(in-memory cache reload) — no restart needed. The **Network security** card in
Server Settings (dashboard → Settings) is the UI over exactly this API.

## Operational notes

- The middleware is registered by `SecurityModule` itself (Nest
  `MiddlewareConsumer`, `forRoutes('*')`) — it covers the API, the SPA and the
  Nest-served surfaces. The express static mounts registered in `main.ts`
  before the Nest router (`/hls`, `/samples`, `/sdk`, `/live`) are *not*
  covered; media-level protection there remains the proxy/firewall's job.
- With `trust proxy` set (main.ts), the client IP is the first
  `X-Forwarded-For` hop — correct behind Caddy/nginx. If you expose core
  directly (no proxy), XFF can be spoofed; that is one more reason this layer
  is a complement, not a substitute, for perimeter controls.
- A banned public IP receives 429 on **every** route, including `/api/v1/health`
  — public health probing from an abusive IP is not a supported use case;
  loopback/private liveness is unaffected.
- Tables: `ip_rules`, `ip_bans` (global `streamhub.db`, created idempotently —
  same pattern as `sessions` / `magic_tokens`).
