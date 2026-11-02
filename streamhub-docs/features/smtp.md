# SMTP overrides — per-app and per-user (owner item 29)

## What it does

StreamHub sends transactional email over a single **global** SMTP relay by
default (`STREAMHUB_SMTP_*` env — see
[operations/ENV.md](../operations/ENV.md#email-smtp--magic-links-invites)).
This feature adds two optional overrides, resolved in this precedence order
for every outbound send:

**per-user SMTP > per-app SMTP > global env default.**

| Mail category | Trigger | Resolution context |
|---|---|---|
| Magic-link sign-in (`sendMagicLink`) | `POST /auth/magic-link` — a user requests their own sign-in link | none → **global only** (since 3.3.3) |
| Team invite (`sendInvite`) | `POST /tenant/invites` — an owner invites a teammate | none → **global only** (since 3.3.3) |
| Email-change confirmation + notice | `PATCH /account { email }` (3.3.3) | none → **global only** || App notifications (notifier email channel) | `NotifierService.notify(app, event, …)` — any app-scoped alert with the email channel enabled | `{ app }` |

Only the notifier email channel has an `app` context (invites and magic-links
are not app-scoped). **Authentication mail never uses an override** (3.3.3):
until 3.3.2 magic links went through the account holder's SMTP and invites
through the inviter's, so whoever ran that SMTP server could read sign-in links
meant for somebody else's mailbox (and, combined with an unverified email
change, take over the superadmin). The per-user tier stays available for
outgoing notifications only.

Both overrides are **never falsely reported as sent**: `EmailService` never
throws — every send returns `{ ok, messageId?, error?, skipped? }`, and a
misconfigured/disabled override or a decrypt failure silently falls through to
the next tier instead of failing the request that triggered it (e.g. a magic
link send always returns generic 200 regardless).

## Per-app SMTP

Config.yaml block — full reference in
[config-reference.md](../config-reference.md#smtp):

```yaml
smtp:
  enabled: false
  host: ""
  port: 587                      # 587 = STARTTLS; 465 = implicit TLS
  user: ""
  from: ""                       # e.g. "My App <no-reply@example.com>"
  pass_env: APP_LIVE_SMTP_PASS   # REFERENCE — value in secrets.json/env
```

API: `GET /apps/{app}/smtp` (password **masked**, like the S3/MQTT
credentials) and `PUT /apps/{app}/smtp` (partial update; omit `pass` to keep
the stored one) — same credential pattern as S3/MQTT: the password is written
to `data/secrets.json` (chmod 600), never the yaml. `POST
/apps/{app}/smtp/test { to }` sends a probe email using the app's OWN
configured SMTP, **bypassing the `enabled` gate**, so an operator can verify
the settings before flipping the switch live. The dashboard exposes all three
in **App → Integraciones → SMTP**.

## Per-user SMTP

Outgoing notifications a user owns can go through their personal SMTP —
never authentication mail (magic links, invites, email-change confirmations
always use the global SMTP, see above). Stored on
the global `users` table (`smtp_enabled`, `smtp_host`, `smtp_port`,
`smtp_user`, `smtp_from`, `smtp_pass_enc`) — the password is **encrypted at
rest** (AES-256-GCM, key derived from `STREAMHUB_JWT_SECRET`,
domain-separated from the TOTP 2FA secret so the two can never cross-decrypt —
see `streamhub-core-go/internal/auth/cipher.go`), never plaintext.

API: `GET /account/smtp` (masked), `PUT /account/smtp` (partial update, omit
`pass` to keep the stored one), `POST /account/smtp/test { to }` (probe,
bypasses the `enabled` gate). Every route acts on the CALLER's own account —
there is no `:userId` param. `api_token` principals get 403 (machines have no
account). Dashboard: **Mi cuenta → Seguridad → SMTP override**.

## Failure semantics

- Neither override configured → the global env default is used (unchanged
  pre-existing behaviour).
- An override `enabled: false`, or missing `host`/password → that tier is
  skipped, falling through to the next one.
- Per-user decrypt failure (rotated/wrong `STREAMHUB_JWT_SECRET`) → treated as
  "not configured" for that tier, falls through — never throws.
- The `.../smtp/test` probes intentionally bypass the `enabled` gate (so
  settings can be verified before going live) but never fall back to another
  tier — a probe tests exactly the tier it was called on.

## See also

- [config-reference.md](../config-reference.md#smtp) — the `smtp:` config.yaml block.
- [operations/ENV.md](../operations/ENV.md#email-smtp--magic-links-invites) — the global env default.
- `streamhub-core-go/internal/email/email.go` — precedence resolver + probe methods.
- `streamhub-core-go/internal/auth/cipher.go` — the encryption used for the per-user password.
