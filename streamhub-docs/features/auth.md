# Built-in auth (users, teams, roles)

## What it does

StreamHub ships a self-contained authentication + multi-tenant authorization
system (no external IdP required):

- **Signup** with email/password (scrypt-hashed), **gated by
  `STREAMHUB_ALLOW_SIGNUP`** (default OFF → invite-only). Each signup creates a
  **user**, a new **team** (tenant) on the free plan, and an **owner** membership.
  `GET /auth/config` tells the SPA whether to offer "Create account".
- **Login** with email/password returns a short-lived **JWT** (~12h, HS256,
  signed with `STREAMHUB_JWT_SECRET`, `sub` = user id). The SPA stores it and
  sends it back as `Authorization: Bearer <jwt>`.
- **Passwordless magic-link** (`/auth/magic-link` → `/auth/magic/verify`) with a
  **60s resend cooldown per email** (429 + `retryAfterSeconds`) — the default
  sign-in flow. **There is no password-recovery flow**: a user who forgets their
  password just signs in with a magic link (password login stays only for
  accounts that set one at signup, and the break-glass admin).
- **2FA (TOTP)** per account: enrol from "Mi cuenta" (QR + authenticator app);
  when enabled, BOTH password login and magic-link verify demand a 6-digit
  `code` (401 `totp_required` / `totp_invalid`).
- **Active sessions** (`/auth/sessions`): every human sign-in mints a revocable
  session (id embedded in the JWT as `sid`); the owner can list them (IP + dates)
  and revoke any from "Mi cuenta". The validator rejects a token whose session
  was revoked, so "sign out this device" takes effect everywhere. Setting a
  password signs out the rest (3.3.4): `POST /account/password` revokes every
  other session of the user (the one making the change stays), and completing
  an invitation's signup (the only other path that sets a password — there is
  no reset flow) revokes all earlier ones.
- **"Mi cuenta" self-service** (`/account`): profile (name/email), password
  change, 2FA management, and active sessions — always scoped to the caller's
  own user.
- **Email invitations** (`/tenant/invites`): a team owner invites by email; a
  new invitee gets a 72h single-use link and lands in the team as a member.
- **Memberships by consent** (3.3.4): inviting an email that **already has an
  account** (`/tenant/invites` or `/teams/mine/members`) never attaches it on its
  own — it creates a **pending membership** (listed as a pending member, no role
  until answered) and the mail points at "Mi cuenta" (no sign-in link). The user
  accepts or declines it there (`/account/invitations`). Accepting does not move
  the user's tenant: the **primary** tenant (default of every new session) is
  their own owned team, else their oldest membership — an accepted invitation,
  even as owner, never displaces it.
- **Active tenant per session** (3.3.4): a user in several teams picks the one
  to work in with `POST /account/tenants/{tenantId}/switch`; the choice is pinned
  on the session row (`sessions.tenant_id`), so it survives reloads, applies to
  every request of that session (REST, WS, SSE — no header to forward) and dies
  with it. A session without a pick (or whose pick is no longer an active
  membership) resolves to the primary tenant. API tokens stay pinned to their
  own tenant; the superadmin is not tenant-scoped.
- **Break-glass superadmin**: `ADMIN_USER`/`ADMIN_PASS` (constant-time compare) —
  the platform owner can never be locked out. Logs in via the same `/auth/login`,
  yields a superadmin JWT. **Exempt from 2FA**; its email/password are
  env-managed (the account API refuses to change them).
- **Teams are isolated by construction**: a user only ever sees their own tenant.
  Team is taken from the resolved `AuthContext`, never a path param.
- **Roles** (per membership): `owner`, `editor`, `viewer`. Plus global
  `superadmin`. Enforced by Casbin RBAC-with-domains (domain = tenantId).
- **API tokens** (`sk_...`) are a separate credential kind for automation — see
  [tokens.md](tokens.md). They have no account: `/account*` answers 403.

There are three credential kinds the guard resolves, in priority order:
1. `sk_...` → api_token principal (`via:api_token`; global token = superadmin/global).
2. non-`sk_` JWT for a built-in user → `via:user_jwt`, mapped to team + role.
3. non-`sk_` JWT for the break-glass admin (or any `is_superadmin` user) → `via:admin_jwt`, superadmin.

## Roles → permissions (Casbin policy)

| Role | Capabilities |
|------|--------------|
| `owner` | `*:*` within their tenant (full control) |
| `editor` | read everything; create/write/operate apps, config, s3, streams, recording, vod, broadcast, sample, ingress; **cannot** delete the app or manage tenant/tokens |
| `viewer` | `*:read` only |
| `superadmin` | bypasses Casbin entirely (never lockable) |
| `service` (api_token) | broad allow; global token also `isSuperadmin` |

Enforcement is **phased** via `STREAMHUB_AUTHZ_ENFORCE`: `off` (no checks),
`log` (log-only — "would-deny"), `on` (reject; **the default** in code, the
installer and `.env.example`). A few sensitive actions (e.g. inviting members)
are enforced regardless of the phase.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/auth/config` | public | `{ allowSignup }` — public auth capabilities |
| POST | `/auth/signup` | public (gated) | Create user + team + owner membership, return JWT |
| POST | `/auth/login` | public | Log in (user or break-glass admin), return JWT |
| POST | `/auth/magic-link` | public | Email a sign-in link (60s cooldown per email) |
| POST | `/auth/magic/verify` | public | One-time token (+ TOTP `code` if 2FA) → JWT |
| GET | `/auth/me` | Bearer | Resolved AuthContext for the current credential |
| GET | `/account` | Bearer (human) | My profile + tenant + security flags |
| PATCH | `/account` | Bearer (human) | Update my name; request an email change (confirmed by mail, `pendingEmail`) |
| POST | `/account/password` | Bearer (human) | Change my password (needs the current one) |
| POST | `/account/2fa/setup` | Bearer (human) | Start TOTP enrolment (secret + otpauth + QR) |
| POST | `/account/2fa/enable` | Bearer (human) | Verify a live code → activate 2FA |
| POST | `/account/2fa/disable` | Bearer (human) | Verify a live code → disable 2FA |
| GET | `/auth/sessions` | Bearer (human) | List my active sessions (ip, dates, `current`) |
| DELETE | `/auth/sessions/{id}` | Bearer (human) | Revoke one of my sessions (current = sign out) |
| DELETE | `/auth/sessions` | Bearer (human) | Revoke every OTHER session, keep this one |
| GET | `/teams/mine` | usage:read | My team: tenant + members + quota usage |
| GET | `/account/tenants` | Bearer (human) | Teams I'm an active member of (`current` = this session's) |
| POST | `/account/tenants/{tenantId}/switch` | Bearer (human) | Work in another of my teams (pinned on this session) |
| GET | `/account/invitations` | Bearer (human) | Team invitations waiting for my answer |
| POST | `/account/invitations/{tenantId}/accept` | Bearer (human) | Accept one (my current team doesn't change) |
| POST | `/account/invitations/{tenantId}/decline` | Bearer (human) | Decline one |
| POST | `/teams/mine/members` | tenant:write (owner/superadmin) | Invite/attach a member (no email); an existing account → pending membership |
| GET | `/tenant/invites` | owner/superadmin | Pending email invitations of my tenant (pending users + pending memberships) |
| POST | `/tenant/invites` | owner/superadmin | Invite by email (new email: PENDING user + 72h link; existing account: pending membership + mail to "Mi cuenta") |
| DELETE | `/tenant/invites/{userId}` | owner/superadmin | Revoke a pending invitation |

### GET /auth/config — response

```json
{ "data": { "allowSignup": false } }
```

Public and enumeration-safe. `allowSignup` mirrors the `STREAMHUB_ALLOW_SIGNUP`
env flag; the SPA only shows "Create account" (and the `/signup` onboarding)
when it is true.

### POST /auth/signup — body / response

```json
// body
{ "email": "alice@example.com", "password": "s3cret-passphrase", "teamName": "Acme Streaming" }
// response 201
{ "data": { "token": "<jwt>" } }
```

- **Gated by `STREAMHUB_ALLOW_SIGNUP`**: when the flag is off, a brand-new email
  gets `403 signup_disabled`. An **invited pending** user may ALWAYS complete
  signup (it attaches their password and activates the invite) — invite-only
  deployments keep working.
- `password` min length 8. `teamName` optional (defaults to email).
- Email already in use (real user or admin) → 400.

### POST /auth/login — body / response

```json
// body
{ "user": "alice@example.com", "password": "s3cret-passphrase", "code": "123456" }
// response 200
{ "data": { "token": "<jwt>" } }
```

`user` accepts an email (built-in user) or the admin username. Invalid → 401.
`code` (optional) is the 6-digit TOTP code — see 2FA below.

### 2FA (TOTP)

Per-user two-factor auth over RFC-6238 TOTP (otplib, ±1 window):

1. `POST /account/2fa/setup` → `{ data: { secret, otpauthUri, qrDataUri } }`.
   The secret is stored **encrypted at rest** (AES-256-GCM keyed from
   `STREAMHUB_JWT_SECRET`) as *pending* — 2FA is NOT active yet.
2. `POST /account/2fa/enable { code }` verifies a live code against the pending
   secret and activates it. `POST /account/2fa/disable { code }` turns it off.
3. While enabled, `POST /auth/login` and `POST /auth/magic/verify` answer
   **401 `totp_required`** without a `code` and **401 `totp_invalid`** with a
   wrong one. Magic-link verify checks the code BEFORE consuming the one-time
   token, so the link survives the retry.
4. The env break-glass admin path (`ADMIN_USER`/`ADMIN_PASS`) is deliberately
   exempt — the platform owner can never be locked out (the brute-force
   throttle below counts it per IP for the same reason).

### Brute-force throttle (3.3.4)

Every check of a password or a TOTP code — `POST /auth/login`,
`POST /auth/magic/verify` (its 2FA `code`) and `POST /account/2fa/{enable,disable}`
— goes through an in-memory throttle of the auth module, independent of the
security module's autoban (opt-in) and of the `AUTH_RATE_LIMIT_*` window in
front of the login routes:

- **per client IP**: at most `STREAMHUB_AUTH_IP_LIMIT` (10) attempts a minute
  over all those routes;
- **per account** (keyed by its email, from any IP): after
  `STREAMHUB_AUTH_ACCOUNT_FAILS` (5) consecutive wrong passwords / codes the
  account is locked for 30s, doubling on every further failure up to 15 min.
  While locked even the right password is refused (it isn't checked); a
  success clears the count. A missing TOTP code (the 2FA prompt) is not a
  failure. Unknown emails are counted the same, so the lock says nothing about
  which accounts exist. The break-glass admin is counted per (account, IP), so
  guessing from one address never locks the platform owner out elsewhere.

A refusal is:

```json
// 429, header Retry-After: 30
{ "statusCode": 429, "message": "Too many attempts. Please retry later.",
  "error": "Too Many Requests", "retryAfterSeconds": 30 }
```

`0` disables either dimension. State is per process (a restart clears it).

### Magic-link resend cooldown

`POST /auth/magic-link` refuses a SECOND request for the same email within
**60 seconds**:

```json
// 429
{ "statusCode": 429, "message": "Please wait 42s before requesting another link.",
  "error": "Too Many Requests", "retryAfterSeconds": 42 }
```

With public registration **off**, a link for an email that has no account
(and isn't the superadmin's) is **not sent** and `/auth/magic/verify` never
creates an account — but the answer is the same generic 200 and the cooldown
is armed all the same, so the endpoint still tells nothing about which emails
exist.

The cooldown applies to every address (existing or not) so it leaks nothing
about accounts; the SPA shows a live countdown on the resend button. The
existing sliding-window limits (3/email + 10/IP per 15 min) still apply after
the cooldown. Owner-issued **invite links do not count** against either.

### Email invitations (`/tenant/invites`)

`POST /tenant/invites { email, role? }` (owner/superadmin; role defaults
`viewer`):

- creates a **pending** user (or attaches an existing account) with a
  membership in the CALLER's tenant (never a path param),
- emails a single-use **72h invite link** (same one-time hashed-at-rest token
  model as magic links, `kind='invite'`),
- responds `{ data: { userId, email, role, invitedAt, emailSent } }` —
  `emailSent:false` means SMTP was down; revoke + retry.

The invitee clicks the link → `/auth/magic` verifies it → their pending user is
promoted to active with the membership already in place. An invite link only
activates that **pending** user: if the account is already active (it accepted,
completed signup, or was an existing account when invited) the link answers
`410 invite already used` — that user just signs in normally. They can set a
password later by completing signup with the same email (otherwise they keep
signing in with magic links).
`GET /tenant/invites` lists pending invitations; `DELETE /tenant/invites/{userId}`
revokes one (membership removed, outstanding links invalidated, and the user
row deleted when it was invite-born and never accepted).

### Mi cuenta (`/account`)

`GET /account` → `{ data: { user, tenant } }` where `user` =
`{ id, email, pendingEmail?, name, isSuperadmin, hasPassword, twoFactorEnabled, status, createdAt }`
and `tenant` = `{ id, name, plan, role }`. `PATCH /account { name?, email? }`
updates the name and **requests** an email change (see below). `POST /account/password
{ currentPassword, newPassword }` changes the password. All of it is
self-scoped (the principal comes from the JWT); `sk_` API tokens get 403, and
the break-glass admin's email/password are env-managed (400 on change).

#### Email change (two steps, 3.3.3)

`PATCH /account { email }` with a new address does **not** change it:

1. It validates the address (format, not another user's, not `ADMIN_USER`,
   not `STREAMHUB_SUPERADMIN_EMAIL` → `400 email already in use`), withdraws
   any previous pending request of the caller and mints a single-use **24h**
   token `kind='email_change'` in `magic_tokens` (`email` = the new address,
   `user_id` = the caller; hashed at rest like every magic token).
2. The link (`<STREAMHUB_APP_URL>/auth/magic?token=…`, the same dashboard
   route as a magic link) is mailed to the **new** address and a notice (no
   link) to the current one — both over the **global SMTP only**. Without a
   global SMTP the request is withdrawn and answers `503`; a second request
   within 60s answers `429` + `retryAfterSeconds`.
3. The response is the account with `user.email` unchanged and
   `user.pendingEmail` = the new address (also on `GET /account` while the
   request is live).
4. Following the link runs `POST /auth/magic/verify { token, code? }`: the
   address is re-checked (`400 email already in use` if somebody took it
   meanwhile), 2FA is asserted on the requester, the email is applied and the
   response is a session JWT for the requester — exactly like a magic link.

`users.email` is UNIQUE case-insensitively (index `idx_users_email_lower`,
added at boot). If an older database holds case-insensitive duplicates the
index is **not** applied: the boot log names the user ids
(`UNIQUE index on users.email NOT applied`) until they are given distinct
emails and the core restarts.

### Active sessions (`/auth/sessions`)

Every human sign-in (password login, magic-link, signup — 2FA rides inside
those) creates a row in the global `sessions` table (`id`, `user_id`, `email`,
`ip`, `user_agent`, `created_at`, `last_seen`, `revoked_at`). Its id is embedded
in the JWT as the `sid` claim, and the validator does a cheap (TTL-cached)
lookup on every request: a token whose `sid` is **revoked or missing** is
rejected (401). Legacy tokens minted before this feature (no `sid`) still work,
so shipping it never mass-logs-out live sessions. The client IP is the
`X-Forwarded-For` first hop (core sits behind Caddy/nginx with `trust proxy`).

- `GET /auth/sessions` → `{ data: [ { id, ip, userAgent, createdAt, lastSeen,
  current } ] }` — the caller's own live sessions, newest first; `current` marks
  the one backing this request.
- `DELETE /auth/sessions/{id}` → revoke one of your own sessions (revoking the
  current one signs this device out). Revoking a session that isn't yours (or
  doesn't exist) → 404.
- `DELETE /auth/sessions` → revoke every OTHER session, keeping the current one
  (`{ data: { revoked: <count> } }`).

All three are human-only: an `sk_` API token has no session and gets 403.

### GET /auth/me — response

```json
{ "data": {
  "userId": "usr_...", "tenantId": "ten_...", "role": "owner",
  "isSuperadmin": false, "scope": "user", "via": "user_jwt",
  "email": "alice@example.com"
} }
```

Works for api_token, user_jwt and admin_jwt alike. `null` when unauthenticated.

### GET /teams/mine — response

```json
{ "data": {
  "team":   { "id": "ten_...", "name": "Acme Streaming", "plan": "free", ... },
  "members": [ { "userId": "...", "email": "...", "role": "owner" } ],
  "usage":   { /* UsageReport, see quotas.md */ }
}, "error": null }
```

### POST /teams/mine/members — body

```json
{ "email": "bob@example.com", "role": "editor" }
```

`role` ∈ {owner, editor, viewer}, defaults `viewer`. If the email exists the
user is attached to the team; otherwise a **pending** user is created (they set a
password by signing up later with the same email). Owner/superadmin only.

## Examples

```bash
BASE=https://streamhub.digitalhub.com.ar/api/v1

# signup
JWT=$(curl -s -X POST $BASE/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"s3cret-passphrase","teamName":"Acme"}' \
  | jq -r .data.token)

# who am I
curl -s $BASE/auth/me -H "Authorization: Bearer $JWT"

# invite an editor
curl -s -X POST $BASE/teams/mine/members -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"email":"bob@example.com","role":"editor"}'
```

## Notes

- Passwords are stored scrypt-hashed (`password.util`); tokens minted only when
  `STREAMHUB_JWT_SECRET` is configured (otherwise login is disabled → 401).
- App-scoped api_tokens inherit the tenant of their app; the global api_token
  stays superadmin/global so deployed automation is never locked out.
- The historical Wave-5 spec proposed Logto (external IdP); the shipped
  implementation is this **built-in** auth. The `tenantId` field is still called
  a "Logto org id" in some Swagger descriptions for historical reasons — it is
  just the internal tenant id.
</content>
