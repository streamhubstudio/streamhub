# OWASP Top 10 self-assessment — StreamHub

> **Historical evidence (2.x).** This assessment was made against the 2.x NestJS core; its
> `file:line` citations refer to `streamhub-core/src/…` on branch `legacy/node-2.x` (tag `2.24.0`).
> The 3.x Go core ports every control route-for-route (verified by the parity harness,
> `streamhub-core-go/cmd/parity`); deliberate deviations — including the security fixes the port
> added — are listed in `planning/GO-DIVERGENCES.md`. File mapping for re-verifying against the
> Go core:
>
> | 2.x file (`streamhub-core/src/…`) | Go core (`streamhub-core-go/internal/…`) |
> |---|---|
> | `main.ts` (security headers, body parsers, trust-proxy, static mounts) | `server/server.go`, `platform/httpx/{middleware,request,jsonbody}.go`, `platform/web/static.go` |
> | `modules/auth/auth.service.ts`, `totp.service.ts` | `authn/{service,account,session,magic,totp}.go` |
> | `modules/auth/password.util.ts`, `secret-cipher.util.ts`, `shared/auth/jwt.util.ts` | `auth/{password,cipher,jwt}.go` |
> | `modules/authz/{permission.guard,authz.service,authz.constants,rbac-model}.ts` | `authz/{guard,authz}.go` |
> | `shared/http/auth-rate-limit.ts` | `platform/httpx/ratelimit.go` |
> | `modules/security/{egress-url.guard,ip-cidr.util,security.middleware}.ts` | `security/{egress,ipcidr,middleware}.go` |
> | `modules/callbacks/callbacks.service.ts` | `callbacks/callbacks.go` |
> | `modules/s3/s3.service.ts` | `s3/{service,secrets}.go` |
> | `modules/livekit/{livekit.controller,webhooks.controller,livekit.service}.ts` | `livekit/{routes,webhooks,service}.go` |
> | `modules/mqtt/{mqtt.service,mqtt-client.factory}.ts`, `set-mqtt.dto.ts` | `mqtt/{service,client}.go`, `apps/masked.go` |
> | `modules/metrics/{metrics.controller,metrics.service}.ts` | `metrics/{routes,metrics}.go` |
> | `modules/logs/logs.service.ts` | `logs/service.go` |
> | `modules/apps/{apps.controller,apps.service}.ts` | `apps/{routes,service}.go` |
> | `modules/{admin,system,cluster,db-admin,tenancy}/…` | `admin/`, `system/`, `cluster/`, `dbadmin/`, `tenancy/` |
> | `shared/db/db.service.ts`, `shared/config/config.service.ts` | `platform/db/db.go`, `platform/config/config.go` |

**Edition:** OWASP Top 10 **2025** (announced Nov 2025, final Jan 2026). This is the
current release; where 2025 folded a former item into another (SSRF → A01, and the
new A03 Supply-Chain / A10 Exceptional-Conditions categories) it is called out.
**Date of assessment:** 2026-07-06 · **Scope:** `streamhub-core` (+ web, adaptor,
python workers, deploy assets) at HEAD of `main`. · **Method:** code review with
`file:line` evidence; every prior finding in `PRODUCT-EVALUATION.md §3.4` re-verified
against current code.

## Framing — this is not a certification

The OWASP Top 10 is an **awareness document**, not a certifiable standard. There is
no "OWASP Top 10 certificate." The right way to *demonstrate* alignment is a
**self-assessment against the OWASP ASVS** (Application Security Verification
Standard) and to keep the evidence current. This document is that self-assessment,
scored per Top-10 category, and it closes with an honest ASVS-level statement
(§ASVS). "PASS" here means "no material weakness found in this category," not a
warranty.

## Verdict summary

| # (2025) | Category | Verdict | Headline |
|---|---|---|---|
| A01 | Broken Access Control (incl. SSRF) | **PARTIAL** | Multi-tenant isolation now enforced; **4 tenant-reachable SSRF vectors** + secrecy-only public playback remain |
| A02 | Security Misconfiguration | **PARTIAL** | helmet + metrics default-deny landed; containers root + `network_mode: host` + floating images |
| A03 | Software Supply Chain Failures | **FAIL** | 10 high npm advisories in the shipped tree; unsigned/unpinned installer; floating base images; no SCA in CI |
| A04 | Cryptographic Failures | **PASS** | scrypt N=2¹⁵, HS256 w/ alg-pinning + timing-safe, AES-256-GCM at rest; only key-rotation gaps |
| A05 | Injection | **PASS** | SQL 100% parametrized (verified); `execFile`/no-shell; validation pipe whitelists |
| A06 | Insecure Design | **PARTIAL** | Strong fail-closed design, but single LiveKit key = one trust root for all tenants |
| A07 | Authentication Failures | **PARTIAL** | Rate-limit + session revocation + 2FA present; **X-Forwarded-For spoofable** defeats IP controls |
| A08 | Software & Data Integrity Failures | **FAIL** | Inbound webhooks verified; **installer has no signature/pin**; no artifact signing |
| A09 | Logging & Alerting Failures | **PARTIAL** | Retained app logs exist; **no security audit trail**, mutable logs, alerting not deployed |
| A10 | Mishandling of Exceptional Conditions | **PASS** | Pervasive fail-safe patterns, idempotent migrations w/ backup, guards fail-closed when enforcing |

**Counts:** PASS 3 · PARTIAL 5 · FAIL 2.

---

## A01:2025 — Broken Access Control (now includes SSRF) — PARTIAL

### What is now fixed (verified)

The three P0 multi-tenant-isolation findings from §3.4 are **closed in code**:

1. **App-scoped isolation runs BEFORE the `api_token` RBAC bypass.**
   `PermissionGuard.canActivate` evaluates `crossAppViolation()` first, and only
   then short-circuits `via:'api_token'` principals —
   `streamhub-core/src/modules/authz/permission.guard.ts:78-90`. A per-app `sk_`
   token for app A can no longer act on `/apps/B/...`.
2. **`createToken()` sets `tenant_id` explicitly** (app-scoped → the app's tenant,
   global → platform) — `streamhub-core/src/modules/auth/auth.service.ts:406-451`.
   Previously every token inherited the column default and was effectively
   unscoped.
3. **Enforcement is secure-by-default.** `enforcementMode()` resolves unset/invalid
   `STREAMHUB_AUTHZ_ENFORCE` to `'on'` —
   `streamhub-core/src/modules/authz/authz.constants.ts:30-33` (commit `82e51ad`).

Coverage check: the dangerous app-scoped routes all carry `@RequirePermission`, so
the isolation check actually fires on them —
`POST /apps/:app/db/purge` → `('app','delete')`
(`streamhub-core/src/modules/db-admin/db-admin.controller.ts:98-99`);
`POST /apps/:app/tokens` → `('stream','write')`
(`streamhub-core/src/modules/livekit/livekit.controller.ts:116-117`);
config read/write and S3 setters
(`streamhub-core/src/modules/apps/apps.controller.ts:143-260`); restream/broadcast
(`.../restream/restream.controller.ts:56-97`, `.../broadcast/broadcast.controller.ts:45-92`).

### Residual weaknesses

- **SSRF is A01 in 2025, and StreamHub has four tenant-reachable SSRF vectors, all
  unguarded.** A normal `editor`/`owner` customer (not the host operator) holds
  `config:write`/`s3:write`/`ingress:create`
  (`streamhub-core/src/modules/authz/rbac-model.ts:38,48-51,71`), so these are
  reachable by a paying tenant:
  - **Outbound webhooks — arbitrary `fetch()`**: `callbacks.service.ts:153` dials
    `config.callbacks.url` (set via `PATCH /apps/:app/config` `callbackUrl`,
    validated only `@IsString() @MaxLength(2048)` —
    `apps/dto/update-app-config.dto.ts:104-108`). No scheme/host/private-IP check →
    `http://169.254.169.254/latest/meta-data/…`, `http://127.0.0.1:3020/…`, RFC1918
    all reachable. Blind (status logged, body not returned) but a working internal
    probe + cloud-metadata oracle.
  - **Custom S3 endpoint**: `s3.service.ts:241` `new S3Client({ endpoint })` from
    `config.s3.endpoint` (`apps/dto/set-s3.dto.ts:33-37`, length-only). Signed
    requests to any internal host.
  - **MQTT broker URL**: `mqtt/mqtt-client.factory.ts:66` connects to
    `config.mqtt.url` (any host:port, `set-mqtt.dto.ts:81-89`).
  - **URL-pull ingress**: `livekit.controller.ts:338` → `livekit.service.ts:442`
    forwards `CreateIngressDto.url` blind to the LiveKit ingress worker
    (`create-ingress.dto.ts:58-65`), which can pull `rtsp://internal/…` or
    `http://169.254.169.254/…`.
  The remediation primitive already exists but is unused on egress:
  `isPrivate()` / `PRIVATE_CIDRS` in
  `streamhub-core/src/modules/security/ip-cidr.util.ts`.
  Restream/broadcast RTMP **push** is lower-risk — scheme is pinned to
  `^rtmps?://` (`restream/restream.presets.ts:36`, `broadcast.service.ts:51`).
- **Public playback authorization = room-name secrecy.**
  `GET /api/v1/livekit/play-token/:room` is `@Public()` and mints a subscribe token
  for *any* room name (`streamhub-core/src/modules/livekit/livekit.controller.ts:227-231`);
  same for the radio listen-token (`:182`). Anyone who learns/guesses a room name
  can watch. No signed, short-lived, tenant-scoped play URL.
- **`crossAppViolation` fails-open on missing signal** (unknown token app or route
  app → no block, `permission.guard.ts:114-128`). Correct as defense-in-depth, but
  it means the isolation guarantee depends on `req.auth.appId` always being
  populated (it is, via `validate()` `auth.service.ts:385`) — worth a regression
  test asserting the deny path.

**Fix:** central egress SSRF guard (resolve host, reject private/link-local/loopback
ranges + non-allowed schemes, re-check after DNS resolution) applied to callbacks,
S3 endpoint, MQTT, and ingress URLs; signed short-lived playback tokens (backlog
`S-01`, `S-05`, `S-11`). **Effort: M** (SSRF guard) **+ M** (signed playback).

---

## A02:2025 — Security Misconfiguration — PARTIAL

### Fixed (verified — contradicts §3.4 "sin helmet", "metrics público")

- **helmet is enabled** — `streamhub-core/src/main.ts:187-195` (HSTS, nosniff,
  referrer-policy, x-powered-by off; CSP/CORP/COEP/frameguard deliberately off so
  the embeddable players/HLS/SDK keep working).
- **`/metrics` is default-deny**: returns **404** unless `METRICS_TOKEN` is set, and
  requires a matching bearer/`?token=` otherwise —
  `streamhub-core/src/modules/metrics/metrics.controller.ts:47-64`. Caddy also
  `respond 403` on `/metrics` externally (`deploy/Caddyfile:32-34`). Defense in
  depth; the §3.4 "scrapeable by default" finding is closed.
- `GET /system/settings` returns effective config **with every secret redacted**
  (`streamhub-core/src/modules/system/system.controller.ts:70-73`).

### Residual

- **Containers run as root under `network_mode: host` on every service** (redis,
  livekit, ingress, egress, core, caddy) — `docker-compose.yml` (host mode at
  `:27,38,78,104,147,168`); the runtime Docker stage has **no `USER`** and the
  entrypoint documents "core runs as root" (`deploy/core-entrypoint.sh:6`). A core
  RCE is effectively host-level.
- **No mem/cpu limits on core, livekit, redis, caddy** (only ingress/egress capped,
  `docker-compose.yml:82-83,121-122`) → one runaway tenant/process can OOM the box
  (also §3.3 M7).
- **Floating image tags**: `livekit/ingress:latest`, `livekit/egress:latest`
  (`docker-compose.yml:76,102`), plus minor-floating `redis:7-alpine`,
  `caddy:2-alpine`, `node:20-bookworm` — no digest pinning (also A03).
- Global CSP is off (intentional for the players) — acceptable, but leaves the SPA
  without a CSP; a per-route CSP on the dashboard would tighten this.
- `Access.md` / `deploy-streamhub.sh` hold PROD secrets in cleartext in the working
  tree (gitignored, not committed, but present on disk — rotate + move out).

**Fix:** non-root core user (uid mapped into the gid-0 data-dir convention egress
already uses), resource limits on all services, pin images to digests, per-route
dashboard CSP. **Effort: M.**

---

## A03:2025 — Software Supply Chain Failures (NEW) — FAIL

`npm audit` (online) on the three JS components:

| Component | Critical | High | Moderate | Low | Lockfile |
|---|---|---|---|---|---|
| `streamhub-core` | 0 | **10** | 15 | 3 | yes |
| `streamhub-web` | 0 | 0 | 0 | 0 | yes |
| `streamhub-adaptor` | 0 | 0 | 0 | 1 | yes |

**Shipped-tree highs** (survive `npm prune --omit=dev`, `deploy/Dockerfile:34`):

- **nodemailer** (direct prod dep) — SMTP command injection via CRLF
  (GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g), file-read/SSRF via message `raw`
  (GHSA-p6gq-j5cr-w38f). Used for magic-link/reset mail — highest-value fix.
- **multer** (via `@nestjs/platform-express`) — 5 DoS advisories.
- **path-to-regexp** (via `@nestjs/serve-static`) — ReDoS (GHSA-9wv6-86v2-598j).
- **lodash** (via `@nestjs/swagger@8.1.1`) — `_.template` code injection
  (GHSA-r5fr-rjxr-66jc) + prototype pollution.
- Most fixes require the **NestJS 10→11** major bump (`isSemVerMajor: true`).

**Python workers** — floating, no hashes: `yolo-worker/requirements.txt` and
`deface-worker/requirements.txt` use `>=` ranges only; each image build resolves
whatever is newest (`deploy/Dockerfile:74-80`).

**Base images** — `livekit/*:latest` fully floating; only
`livekit/livekit-server:v1.8.4` is tag-pinned (not a digest).

**CI** — `.gitlab-ci.yml` exists (build/test/coverage/shellcheck) but has **no
`npm audit` / SCA / SAST / container-scan job**; the image is only ever built on the
target host by the installer. No GitHub Actions.

**Fix:** upgrade nodemailer now; plan the NestJS 11 bump; pin base images to
digests; hash-pin python deps (`pip-compile --generate-hashes`); add
`npm audit --omit=dev` + a container scan (Trivy/Grype) to CI as a gate.
**Effort: M** (audit remediation) **+ S** (CI gate).

---

## A04:2025 — Cryptographic Failures — PASS

- **Password hashing:** salted **scrypt N=2¹⁵, r=8** with per-user 16-byte salt,
  self-describing params, constant-time verify —
  `streamhub-core/src/modules/auth/password.util.ts:17-24,80-110`.
- **JWT:** hand-rolled HS256 that **pins `alg:HS256`** (rejects alg-confusion) and
  compares signatures with `timingSafeEqual` —
  `streamhub-core/src/shared/auth/jwt.util.ts:56-79`. Secret required or login is
  refused (`auth.service.ts:302-309`).
- **TOTP secret at rest:** AES-256-GCM, key domain-separated from the deployment
  secret — `streamhub-core/src/modules/auth/secret-cipher.util.ts:28-46`.
- **API tokens:** stored **sha256 hash only**, plaintext shown once
  (`auth.service.ts:576-582`); IP-whitelist supported per token.
- **Webhooks (inbound):** LiveKit signature verified over the exact raw bytes (see
  A08). **Outbound** callbacks HMAC-SHA256 over the body with a per-app secret —
  `callbacks.service.ts:131-134`.
- TLS terminated by Caddy with automatic certs (`deploy/Caddyfile`).

**Minor gaps (not blocking PASS):** single static `STREAMHUB_JWT_SECRET` with **no
rotation / `kid`** (a leak invalidates every session only via manual rotation, and
all sessions at once); the TOTP at-rest key is *derived from* the JWT secret, so
rotating one re-keys the other; **outbound webhook HMAC is conditional** — if a
tenant configures no secret the callback is sent **unsigned** (`callbacks.service.ts`).

**Fix:** support keyed JWT rotation (`kid` + overlapping secrets); decouple the
TOTP key from the JWT secret; make outbound webhook signing mandatory (auto-generate
a secret). **Effort: M.**

---

## A05:2025 — Injection — PASS

- **SQL is 100% parametrized** (verified): no template-literal interpolation in any
  `prepare()/get()/all()/run()` across `src` (grep clean). The only `db.exec()`
  interpolations are (a) internal file paths from `sqlPath()`
  (`streamhub-core/src/shared/db/db.service.ts:214,239,273`) and (b) a **hardcoded**
  DDL allow-list in `ensureUserAuthColumns()`
  (`streamhub-core/src/modules/tenancy/tenancy.service.ts:216`) — neither takes
  user input.
- Dynamic `ORDER BY` uses column whitelists (per §3.2), not interpolation.
- **No shell injection:** ffmpeg snapshot uses `execFile('ffmpeg', [...])` (no
  shell) with a server-built source (`streams.service.ts:666`); the only `exec()`
  with a string is `admin/restart` using an **operator-env** unit name, gated to
  global-scope tokens (`admin.controller.ts:48-58`).
- Input validated by a global `ValidationPipe({ whitelist:true })`
  (`main.ts:236-241`) plus per-DTO `class-validator` rules.

No material injection weakness found. Keep the "no string-built SQL" invariant under
test.

---

## A06:2025 — Insecure Design — PARTIAL

**Strong design choices:** fail-closed boot assert (refuses to start in prod without
`AUTH_VALIDATOR`, `main.ts:154-171`); phased `off|log|on` enforcement with
secure default; per-app SQLite as a hard tenant boundary; "logging never crashes";
idempotent migrations with a `VACUUM INTO` backup first.

**Design-level weaknesses:**

- **Single LiveKit API key/secret is the one trust root for all media of all
  tenants, and it is handed to every joining node** —
  `streamhub-core/src/modules/cluster/cluster.service.ts:199-202` returns
  `livekitApiKey`/`livekitApiSecret` in the `/cluster/join` response. Compromise of
  any edge = ability to mint tokens for every tenant's rooms (also §3.4 blocker,
  backlog `S-08`).
- **Playback trust = unguessable room name** (see A01) — no capability-based design.
- **No general-API rate limiting or per-tenant resource quotas at the request
  layer** — only the 3 auth paths are limited (`shared/http/auth-rate-limit.ts`).
  With a synchronous better-sqlite3 single writer (§3.2), one tenant's load is a
  shared-fate design risk (DoS by design).

**Fix:** per-node/per-tenant LiveKit keys with a rotatable master; capability-based
signed playback; global API throttle + per-tenant quotas at the edge. **Effort: L.**

---

## A07:2025 — Authentication Failures — PARTIAL

**Present and good:** brute-force **rate limiting** on login/magic-link/verify
(`streamhub-core/src/shared/http/auth-rate-limit.ts`, wired in `main.ts:206-208`);
**session revocation** — JWTs carry a `sid` and are rejected once the session row is
revoked/expired (`auth.service.ts:513-520`), so "sign out this device" is real;
**TOTP 2FA**; scrypt hashing; **no user enumeration** on magic-link/reset (§3.4);
per-token IP allowlist; presented-but-invalid tokens recorded as offenses feeding
auto-ban (`auth.service.ts:351-355,499-503`).

**Residual weaknesses:**

- **`X-Forwarded-For` is trusted blindly and defeats the IP controls.** Both IP
  resolvers take the **first, client-controlled** XFF entry instead of Express's
  proxy-validated `req.ip`:
  `clientIpOf()` — `streamhub-core/src/modules/security/ip-cidr.util.ts:187-193`;
  token whitelist `clientIp()` — `auth.service.ts:650-658`. Consequences:
  - a token's IP-allowlist can be **bypassed** by setting
    `X-Forwarded-For: <allowed-ip>`;
  - the auto-ban / blocklist can be **evaded** by rotating the first XFF entry;
  - worst: `X-Forwarded-For: 127.0.0.1` hits the middleware's step-1 "private/loopback
    always passes" (`security.middleware.ts:71-74`) and **bypasses all network
    security**. `app.set('trust proxy', 1)` is set (`main.ts:200`) so `req.ip` is
    correct — the code just doesn't use it here.
- **No JWT secret rotation** (A04) and static break-glass `ADMIN_USER`/`ADMIN_PASS`.
- **No account lockout** beyond the shared IP rate-limit; no MFA-enforcement policy
  (2FA is opt-in per user).

**Fix:** resolve client IP from `req.ip` (or the last hop) everywhere, never from
raw `XFF[0]`; make private-IP fast-path use the validated peer only; add per-account
lockout + optional MFA enforcement. **Effort: S** (IP resolution) **+ M** (lockout/MFA
policy).

---

## A08:2025 — Software & Data Integrity Failures — FAIL

**Good — inbound webhook integrity is correct.** LiveKit webhooks are verified over
the **exact raw bytes**: `req.rawBody` (enabled at `main.ts:222`) + `Authorization`
header → `webhookReceiver.receive()`
(`streamhub-core/src/modules/livekit/webhooks.controller.ts:92-105`,
`livekit.service.ts:797-799`); any failure → 401. Config edits keep timestamped
backups (`apps.controller.ts:205-260`).

**Failing — the delivery/update chain has no integrity verification** (§3.4 finding
confirmed current):

- **Installer runs unverified remote code as root, from a mutable source:**
  `install.sh:5` `curl -fsSL …/install.sh | sudo bash`; POSIX prologue
  **re-downloads and re-execs itself** (`install.sh:33`); `git clone --depth 1`
  of the **default branch, no tag/commit pin** (`install.sh:515`), `git pull
  --ff-only` on re-run (`install.sh:507`); tarball fetched with **no hash compare**
  (`install.sh:448`). A **sha256 already exists** in the published `latest.json`
  (`deploy/make-release-artifact.sh:102-111`) and the installer even fetches it —
  but only for the `--dry-run` version preview (`install.sh:341-345`), never to
  verify the download. Nested `curl … get.docker.com | sh` as root (`install.sh:377`).
- **No artifact signing** anywhere (sha256-only, co-hosted with the artifact on the
  same web origin → not a real integrity anchor); publish job does host-key TOFU
  (`.gitlab-ci.yml:175`).
- **Webhook replay:** inbound signature stops forgery, but there is **no
  nonce/`event.id` dedup** — a captured signed webhook can be replayed within the
  LiveKit JWT TTL. Low risk (handlers are idempotent upserts) but a gap.

**Fix:** verify the tarball against the already-published sha256 (one-line
consumption of existing data), then add a **detached signature** (minisign/cosign)
verified before exec; pin `git clone --branch <tag>`; add CI artifact signing; dedup
webhooks by `event.id`. **Effort: M.**

---

## A09:2025 — Logging & Alerting Failures — PARTIAL

**Present:** structured app logging into `server_logs` (level/source/app_id/message)
with **retention** (`LOG_RETENTION_DAYS`, default 30) and a periodic purge
(`streamhub-core/src/modules/logs/logs.service.ts:78,289-292`); rotating file stream;
per-app log viewer gated by `('usage','read')`; permission denials logged
(`permission.guard.ts:decide()`); auth offenses + auto-ban events recorded
(security module); Prometheus `/metrics` via prom-client.

**Gaps:**

- **No dedicated, structured security audit trail.** Security-sensitive events —
  token create/revoke, config/S3-credential change, `db/purge`, login
  success/failure, permission DENY, IP-rule change — are not written as immutable
  audit records with `{actor, action, target, tenant, ip, timestamp}`. They surface
  only as free-text app-log lines (or not at all), which is insufficient for
  incident reconstruction and for a customer's compliance audit.
- **Logs are mutable and co-located.** `server_logs` lives in the same SQLite the
  app can write/delete; there is no append-only/WORM store and no off-box shipping
  (SIEM/syslog). An attacker with core RCE can rewrite history.
- **Alerting is designed but not deployed** (§3.3): no wired alerts on auth-failure
  spikes, auto-bans, disk/OOM, egress saturation.
- 30-day default retention may be short for regulated customers (many require 12
  months).

**Fix:** add an append-only `audit_log` written on every security-relevant mutation
+ auth outcome; ship logs off-box (syslog/OTLP) to an immutable sink; deploy the
alerting from `OBSERVABILITY-ROADMAP`; make retention configurable up to ≥12 months.
**Effort: M** (audit trail) **+ M** (shipping/alerting).

---

## A10:2025 — Mishandling of Exceptional Conditions (NEW) — PASS

- Pervasive fail-safe patterns: DB `last_used_at` best-effort
  (`auth.service.ts:611-620`), corrupt token-IP JSON → treated as no restriction
  rather than lock-out, casbin enforcer init failure logged without crashing
  (`authz.service.ts:30-40`), migrations idempotent with a prior backup.
- Guards **fail CLOSED when enforcing**: `AuthzService.can()` returns deny on a dead
  enforcer under `mode:'on'` (`authz.service.ts:70-90`); boot refuses to start
  without an auth validator in prod (`main.ts:154-171`).
- Error envelopes are generic — the network middleware reveals nothing about which
  rule matched (`security.middleware.ts:18-24`).

**Notes (not blocking PASS):** several **back-compat paths fail OPEN by design**
(`appBelongsToTenant()` returns `true` on any error / missing column,
`authz.service.ts:120-140`) — safe only because they are gated by enforcement mode;
the SSRF egress paths swallow errors, which is exactly why those probes are *blind*
rather than loud (A01). Keep the fail-open branches under regression tests so a
future refactor can't silently widen them.

---

## ASVS statement — what StreamHub can honestly claim today

Mapping to **OWASP ASVS v4/v5**:

- **ASVS Level 1 (opportunistic):** **not fully met today.** Most L1 items pass —
  V2 (auth: rate-limit, session revocation, scrypt, 2FA), V3 (session mgmt), V4
  (access control: multi-tenant isolation now enforced), V5.3 (output/SQL). The
  blockers to an honest L1 claim are **V12/V5.2 (SSRF & unsafe consumption of
  external URLs)** — four unguarded egress vectors — **V7 (logging: no security
  audit trail)**, and the **X-Forwarded-For trust** weakness in access decisions.
  These are the L1 gaps to close first.
- **ASVS Level 2 (standard — the realistic target for a multi-tenant SaaS):**
  **not met.** Beyond the L1 gaps, L2 additionally needs: SSRF allow-listing with
  DNS-rebinding defense (V12.6), a complete audit trail with integrity protection
  (V7.1–V7.3), cryptographic **key rotation** (V6/V9), verified software supply
  chain (V10 / A03 — clean `npm audit`, signed+pinned installer), and per-tenant
  isolation of resources (V1 architecture).
- **Level 3** is out of scope for the current product stage.

**Honest bottom line:** StreamHub has made real, verifiable progress since the §3.4
review — multi-tenant isolation, secure-by-default enforcement, helmet, metrics
lockdown, rate-limiting, session revocation and strong crypto are all in place. But
it **cannot yet claim ASVS L1** cleanly: **SSRF (A01), the audit-trail gap (A09),
the supply-chain state (A03/A08), and the X-Forwarded-For trust (A07)** are the four
things standing between "good hygiene" and a defensible self-attestation. Closing the
P0/P1 items in `FIX-BACKLOG.md` puts an honest **ASVS L1** within reach; **L2** is a
deliberate roadmap, not a sprint.

---

*See `ISO-27001-READINESS.md` for the ISMS/organisational view and `FIX-BACKLOG.md`
for the deduplicated, priority-ordered remediation list that feeds the next
implementation wave.*

**Sources (OWASP 2025 edition):**
[OWASP Top 10:2025](https://owasp.org/Top10/2025/) ·
[Introduction](https://owasp.org/Top10/2025/0x00_2025-Introduction/) ·
[About](https://owasp.org/Top10/2025/0x01_2025-About_OWASP/) ·
[OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
