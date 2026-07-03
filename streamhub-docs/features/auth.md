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
  **60s resend cooldown per email** (429 + `retryAfterSeconds`).
- **2FA (TOTP)** per account: enrol from "Mi cuenta" (QR + authenticator app);
  when enabled, BOTH password login and magic-link verify demand a 6-digit
  `code` (401 `totp_required` / `totp_invalid`).
- **"Mi cuenta" self-service** (`/account`): profile (name/email), password
  change, 2FA management — always scoped to the caller's own user.
- **Email invitations** (`/tenant/invites`): a team owner invites by email; the
  invitee gets a 72h single-use link and lands in the team as a member.
- **Break-glass superadmin**: `ADMIN_USER`/`ADMIN_PASS` (constant-time compare) —
  the platform owner can never be locked out. Logs in via the same `/auth/login`,
  yields a superadmin JWT. **Exempt from 2FA** and excluded from email resets;
  its email/password are env-managed (the account API refuses to change them).
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
`log` (log-only, default — "would-deny"), `on` (reject). A few sensitive actions
(e.g. inviting members) are enforced regardless of the phase.

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
| PATCH | `/account` | Bearer (human) | Update my name/email |
| POST | `/account/password` | Bearer (human) | Change my password (needs the current one) |
| POST | `/account/2fa/setup` | Bearer (human) | Start TOTP enrolment (secret + otpauth + QR) |
| POST | `/account/2fa/enable` | Bearer (human) | Verify a live code → activate 2FA |
| POST | `/account/2fa/disable` | Bearer (human) | Verify a live code → disable 2FA |
| GET | `/teams/mine` | usage:read | My team: tenant + members + quota usage |
| POST | `/teams/mine/members` | tenant:write (owner/superadmin) | Invite/attach a member (no email) |
| GET | `/tenant/invites` | owner/superadmin | Pending email invitations of my tenant |
| POST | `/tenant/invites` | owner/superadmin | Invite by email (PENDING user + 72h link) |
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
   exempt — the platform owner can never be locked out.

### Magic-link resend cooldown

`POST /auth/magic-link` refuses a SECOND request for the same email within
**60 seconds**:

```json
// 429
{ "statusCode": 429, "message": "Please wait 42s before requesting another link.",
  "error": "Too Many Requests", "retryAfterSeconds": 42 }
```

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
promoted to active with the membership already in place. They can set a
password later via signup (invite completion) or the reset flow.
`GET /tenant/invites` lists pending invitations; `DELETE /tenant/invites/{userId}`
revokes one (membership removed, outstanding links invalidated, and the user
row deleted when it was invite-born and never accepted).

### Mi cuenta (`/account`)

`GET /account` → `{ data: { user, tenant } }` where `user` =
`{ id, email, name, isSuperadmin, hasPassword, twoFactorEnabled, status, createdAt }`
and `tenant` = `{ id, name, plan, role }`. `PATCH /account { name?, email? }`
updates the profile (email uniqueness enforced). `POST /account/password
{ currentPassword, newPassword }` changes the password. All of it is
self-scoped (the principal comes from the JWT); `sk_` API tokens get 403, and
the break-glass admin's email/password are env-managed (400 on change).

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
BASE=https://streamhub.example.com/api/v1

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
