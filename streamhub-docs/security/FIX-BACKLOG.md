# Security fix backlog — StreamHub

> **Historical evidence (2.x).** The `file:line` citations here refer to the 2.x NestJS core
> (`streamhub-core/src/…`, branch `legacy/node-2.x`, tag `2.24.0`). The 3.x Go core ports the same
> controls; see the file mapping in [`OWASP-TOP10-ASSESSMENT.md`](./OWASP-TOP10-ASSESSMENT.md) and the
> deliberate deviations in `planning/GO-DIVERGENCES.md`.

**Date:** 2026-07-06 · **Source:** deduplicated from `OWASP-TOP10-ASSESSMENT.md`
(2025 edition) and `ISO-27001-READINESS.md`. · **Ordering:** P0 (tenant-isolation
class / exploitable-by-a-tenant) → P1 (compliance/integrity blockers) → P2
(hardening) → P3 (roadmap). Effort **S** ≤1d · **M** ~2–5d · **L** >1wk.

Each item lists **what**, **where** (`file:line`), **effort**, and which OWASP/ISO
item it unblocks. This feeds the next implementation wave directly.

> **Verified-fixed since §3.4 — do NOT reopen** (confirmed in current code):
> multi-tenant app-scoped isolation now runs before the api_token bypass
> (`permission.guard.ts:78-90`); `createToken()` sets `tenant_id`
> (`auth.service.ts:406-451`); `AUTHZ_ENFORCE` defaults `on`
> (`authz.constants.ts:30-33`); helmet enabled (`main.ts:187-195`); `/metrics`
> default-deny 404 (`metrics.controller.ts:47-64`) + Caddy 403; auth-path
> rate-limiting (`shared/http/auth-rate-limit.ts`); JWT session revocation via `sid`
> (`auth.service.ts:513-520`); SQL 100% parametrized (A05). These are regression
> surfaces — lock them with tests, don't rebuild them.

---

## P0 — exploitable by a tenant/attacker today

| ID | What | Where | Effort | Unblocks |
|---|---|---|---|---|
| **P0-1** | ✅ **FIXED (2026-07-06).** Central egress SSRF guard shipped as `modules/security/egress-url.guard.ts` (scheme allowlist + private/loopback/link-local/metadata deny, every DNS answer checked) and wired into all four sinks: URL-pull ingress (`livekit/ingress-url.guard.ts`, prior wave), callbacks (`callbacks.service.ts` fire-time **and** `apps.service.ts` save-time), custom S3 endpoint (`s3.service.ts`), MQTT broker (`mqtt.service.ts` + sync check in `mqtt-client.factory.ts`). Operator escapes (default deny): `STREAMHUB_CALLBACK_ALLOW_HOSTS` (empty), `STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT=0`, `STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER=0`. Deny-path specs per sink (fake DNS, no network). DNS rebinding re-check stays out of scope (same stance as the ingress guard). | `modules/security/egress-url.guard.ts`; `callbacks.service.ts`, `apps.service.ts`, `s3.service.ts`, `mqtt.service.ts`, `mqtt-client.factory.ts` | M | OWASP A01 (SSRF), A06 · ISO 8.12, 8.23 |
| **P0-2** | ✅ **FIXED (2026-07-06).** All four hand-parsers of raw `X-Forwarded-For` now use Express's proxy-validated `req.ip` (trust-proxy=1) with socket fallback: `security/ip-cidr.util.ts` `clientIpOf` (feeds the middleware private-fast-path, rules, auto-ban), `auth/auth.service.ts` `clientIp` (token IP allowlist + invalid-token offenses), `auth/session.service.ts` `clientIpFromRequest` (session rows), `auth/magic.controller.ts` `clientIp` (magic-link throttle). Regression specs prove a spoofed `X-Forwarded-For: 127.0.0.1` no longer rides the private fast-path, evades a ban/allowlist-only mode, or satisfies a token IP whitelist. | `ip-cidr.util.ts`, `auth.service.ts`, `session.service.ts`, `magic.controller.ts` | S | OWASP A07, A01 · ISO 8.20, 8.28 |
| **P0-3** | ✅ **FIXED (2026-07-06).** Apps with `features.public_playback: false` now require a signed short-TTL capability URL on BOTH public playback endpoints (`play-token/:room` and the radio `listen-token`): `?exp=&sig=` where `sig = HMAC-SHA256(perAppSecret, app\nroom\nexp)` and `perAppSecret = HMAC(STREAMHUB_JWT_SECRET, 'playback:'+app)` — verified timing-safe (`crypto.timingSafeEqual`), expired/tampered → 403. Minted by the new authenticated `POST /apps/:app/play-token/:room/sign` (stream:read; TTL default 300 s, clamped 30 s–24 h). PUBLIC apps (default) keep anonymous playback unchanged. Primitives in `modules/livekit/playback-url.util.ts`. Note: playback for public apps remains anonymous BY DESIGN — flip `public_playback` off per app to require signatures. | `livekit/playback-url.util.ts`, `livekit.controller.ts` (`playToken`, `listenToken`, `signPlaybackUrl`) | M | OWASP A01, A06 · ISO 8.3 |
| **P0-4** | ✅ **FIXED (2026-07-06).** `modules/authz/isolation.regression.spec.ts` (20 cases) locks the closed P0 in one place: appA's `sk_` token is 403 on appB for token/config/s3/purge/stream permissions AND the ordering is proven (Casbin `can()` spied — never consulted, so `crossAppViolation` fires BEFORE the api_token bypass); the `:name` param path is covered; own-app access stays allowed; the fail-safe branches stay fail-safe; `createToken()` persists `api_tokens.tenant_id` on the ROW (app → app's tenant, global → platform); `STREAMHUB_AUTHZ_ENFORCE` resolves 'on' for unset/typo values and honours explicit `log`/`off`. | `modules/authz/isolation.regression.spec.ts` | S | OWASP A01 · ISO 8.3 |

---

## P1 — compliance / integrity blockers (ship before "managed" or ISO scope)

| ID | What | Where | Effort | Unblocks |
|---|---|---|---|---|
| **P1-1** | ✅ **DONE 2026-07-06** — **Append-only security audit trail** shipped: hash-chained INSERT-only `audit_log` (global DB, SQLite triggers reject UPDATE/DELETE), `GET /system/audit` (+`/verify`) read API, dashboard viewer, 90-day env-configurable retention. Wired: login/signup ±, token mint/revoke, permission DENY, config/S3/MQTT change, db purge, IP rules, moderation. Still to wire (files owned by the security-fixes/backups agents at the time): `auth.service.ts` internals (magic-link consume, session revoke, TOTP toggle), `livekit.controller.ts` play-token mint, backups run/restore. | `streamhub-core/src/modules/audit/` | M | OWASP A09 · ISO 8.15, 8.16, 5.28 |
| **P1-2** | ✅ **DONE (deps + npm/pip gate) 2026-07-06** — nodemailer ^9.0.3, NestJS 10→11 wave, uuid ^11, multer 2.2.0 + esbuild ^0.28.1 overrides → **0 npm advisories** in core/web/adaptor; `sca:npm` (prod HIGH+ gate) + `sca:pip` jobs + weekly scheduled sweep in `.gitlab-ci.yml`. **Remaining:** Trivy/Grype container scan (pairs with P1-6 digest pinning). | `streamhub-core/package.json`; `.gitlab-ci.yml:142,164` | M | OWASP A03 · ISO 8.7, 8.8, 8.29 |
| **P1-3** | **Installer/artifact integrity.** Consume the **already-published** sha256 in `latest.json` to verify the tarball, then add a detached signature (minisign/cosign) verified before exec; pin `git clone --branch <tag>` instead of the default branch. | `install.sh:33,377,448,507,515` (hash exists at `deploy/make-release-artifact.sh:102-111`, only used for `--dry-run` preview `install.sh:341-345`) | M | OWASP A08 · ISO 8.9, 8.19, 8.32 |
| **P1-4** | **Automated, restore-tested backups** of `DATA_DIR` (Litestream or cron `VACUUM INTO`→S3, versioned) with a rehearsed, evidenced restore. | ops + entrypoint; per-app DBs under `<DATA_DIR>/apps/*/app.db` | S/M | ISO 8.13, 8.14 (partial) |
| **P1-5** | **Log immutability & retention.** Ship logs off-box to a WORM/append-only sink (syslog/OTLP); make retention configurable to ≥12 months. | `modules/logs/logs.service.ts:78,289-292` (retention default 30, same-DB storage) | M | OWASP A09 · ISO 8.15 |
| **P1-6** | **Pin base images to digests; add resource limits.** Replace `livekit/ingress:latest`/`egress:latest` and minor-floating tags with digests; add `mem_limit`/`cpus` to core/redis/livekit/caddy. | `docker-compose.yml:25,36,76,102,147,166` (limits only on ingress/egress `:82-83,121-122`) | S | OWASP A02, A03 · ISO 8.6, 8.9, 8.19 |
| **P1-7** | **Mandatory outbound webhook signing.** Auto-generate a per-app callback secret so a callback is never sent unsigned. | `callbacks.service.ts:131-134` (HMAC currently conditional on a configured secret) | S | OWASP A04, A08 · ISO 8.24 |

---

## P2 — hardening

| ID | What | Where | Effort | Unblocks |
|---|---|---|---|---|
| **P2-1** | **Break the single LiveKit key.** Per-node/per-tenant keys with a rotatable master; `/cluster/join` hands a scoped credential, not the master. | `cluster.service.ts:199-202` (returns raw `livekitApiKey`/`apiSecret`) | L | OWASP A06 · ISO 8.21, 8.24 |
| **P2-2** | **JWT key rotation.** `kid` + overlapping secrets; decouple the TOTP at-rest key from `STREAMHUB_JWT_SECRET`. | `jwt.util.ts`, `secret-cipher.util.ts:28-46`, `config.service.ts:68` | M | OWASP A04, A07 · ISO 8.24 |
| **P2-3** | **Non-root core container + network segregation review.** Add a `USER` (uid mapped into the gid-0 data-dir convention egress already uses); reconsider `network_mode: host` for redis/core/caddy. | `deploy/Dockerfile` (no `USER`), `deploy/core-entrypoint.sh:6`, `docker-compose.yml:27,147,168` | M | OWASP A02 · ISO 8.18, 8.22 |
| **P2-4** | **Rotate + relocate cleartext PROD secrets.** Move `Access.md` / `deploy-streamhub.sh` off the working tree; rotate anything they held. | working-tree files (gitignored, present on disk) | S | OWASP A02 · ISO 8.11, 8.12 |
| **P2-5** | **Account lockout + optional MFA-enforcement policy** beyond the shared IP rate-limit. | `auth.service.ts`, `totp.service.ts` | M | OWASP A07 · ISO 8.5 |
| **P2-6** | **Webhook replay defense.** Dedup inbound LiveKit webhooks by `event.id` within the JWT TTL window. | `webhooks.controller.ts:92-105,237` (id logged but not checked) | S | OWASP A08 · ISO 8.21 |
| **P2-7** | **Access-review export.** Report users × roles × tenants × last-used for periodic recertification. | `modules/tenancy`, `modules/auth` (tokens `last_used_at`) | S | ISO 8.2, 8.3, 5.18 |
| **P2-8** | **Per-route dashboard CSP.** Global CSP is off for the players; add a tight CSP on the SPA/admin routes. | `main.ts:187-195` (CSP disabled) | S | OWASP A02 |
| **P2-9** | **Harden `curl\|sh` sub-installs.** The nested `get.docker.com | sh` as root inherits the same unverified-exec risk. | `install.sh:377` | S | OWASP A08 · ISO 8.19 |

---

## P3 — roadmap (availability / scale — larger efforts)

| ID | What | Where | Effort | Unblocks |
|---|---|---|---|---|
| **P3-1** | **Real multi-node media routing + HA** (cluster currently a registry only). | `modules/cluster` | L | ISO 8.14 |
| **P3-2** | **Upgrade-without-downtime** (health-gated rollout, drain WebRTC sessions). | deploy/ops | L | ISO 8.14 |
| **P3-3** | **Global API throttle + per-tenant request quotas** at the edge (today only 3 auth paths are limited; sync SQLite single-writer is shared-fate). | new middleware; `shared/http` | M | OWASP A06 · ISO 8.6 |
| **P3-4** | **hash-pin python worker deps** (`pip-compile --generate-hashes`). | `yolo-worker/requirements.txt`, `deface-worker/requirements.txt` | S | OWASP A03 · ISO 8.7, 8.8 |

---

## Sequencing recommendation

1. **Sprint 1 (P0):** P0-2 (S) + P0-4 (S) first — cheapest, close active bypasses;
   then P0-1 (M, the SSRF guard) and P0-3 (M, signed playback). Ends the
   tenant-exploitable class.
2. **Sprint 2 (P1):** P1-2 + P1-3 + P1-6 (supply-chain/integrity), P1-1 + P1-5
   (audit trail + log immutability), P1-4 (backups), P1-7 (S). This is the
   "managed-offering / ISO-scope" gate.
3. **Then P2** as hardening, **P3** as the availability roadmap.

**One-line status (updated 2026-07-06):** the **entire P0 class is closed** —
tenant isolation (§3.4, locked by regression suite P0-4), egress SSRF on all
four sinks (P0-1), XFF trust (P0-2) and signed private playback (P0-3) are
implemented with tests. Next up is the P1 compliance/integrity block
(supply-chain, audit trail, backups, log immutability).
