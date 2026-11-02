# ISO/IEC 27001 & 27002 readiness — StreamHub

> **Historical evidence (2.x).** The `file:line` citations here refer to the 2.x NestJS core
> (`streamhub-core/src/…`, branch `legacy/node-2.x`, tag `2.24.0`). The 3.x Go core ports the same
> controls; see the file mapping in [`OWASP-TOP10-ASSESSMENT.md`](./OWASP-TOP10-ASSESSMENT.md) and the
> deliberate deviations in `planning/GO-DIVERGENCES.md`.

**Date:** 2026-07-06 · **Scope:** the StreamHub product (`vision-media-server`) as a
component a customer would deploy inside their own ISMS. · **Companion docs:**
`OWASP-TOP10-ASSESSMENT.md` (app-security), `FIX-BACKLOG.md` (remediation).

## Honest framing — a product is not "ISO 27001 certified"

ISO/IEC 27001 **certifies an organisation's Information Security Management System
(ISMS)** — its risk process, policies, management review, and internal audit. It
does **not** certify a piece of software. So the truthful answer to "can StreamHub be
ISO 27001 certified?" is:

- **The product cannot be certified.** *Green Flame / the operating company* can be
  certified, once it runs an ISMS over the people, processes and infrastructure that
  build and operate StreamHub.
- **What the product can be is "ISO-ready":** it can *support* the Annex A / ISO
  27002:2022 controls a certified customer (or the operating company itself) must
  implement, so that deploying StreamHub does not create an unclosable audit finding.

This document therefore does two things: (1) maps the **ISO 27002:2022 §8
technological controls** to concrete StreamHub features with `file:line` evidence,
and (2) lists the **product gaps** that would block a customer's ISO audit, plus the
**organisational** work (policies, risk register, internal audit) that only the
company — not the codebase — can supply.

> ISO 27002:2022 reorganised the old 114 controls into **93 controls in 4 themes**:
> §5 Organizational (37), §6 People (8), §7 Physical (14), §8 Technological (34).
> A product touches mostly **§8** (and a few §5/§7 that its infrastructure informs).

---

## Part 1 — ISO 27002:2022 §8 technological controls mapped to StreamHub

Legend: **Supports** = the product provides a real, usable control · **Partial** =
present but with gaps that an auditor would flag · **Gap** = the product does not
help the customer meet this control today.

| Control | Title | Status | Evidence / gap |
|---|---|---|---|
| **8.1** | User endpoint devices | n/a | Customer-side. |
| **8.2** | Privileged access rights | **Partial** | Superadmin / global-token vs `owner/editor/viewer/service` roles exist (`streamhub-core/src/modules/authz/authz.constants.ts:39`, `rbac-model.ts`); break-glass `ADMIN_USER/PASS` is a static shared credential (`config.service.ts`), and there is **no privileged-access review report**. |
| **8.3** | Information access restriction | **Supports** | RBAC via Casbin gated by `@RequirePermission` + secure-by-default enforcement (`authz.constants.ts:30-33`); multi-tenant isolation enforced before the token bypass (`permission.guard.ts:78-90`). |
| **8.4** | Access to source code | **Partial** | Repo is in a private namespace; but `.gitlab-ci.yml` build/test gate exists. No documented branch-protection / code-review policy evidence. |
| **8.5** | Secure authentication | **Supports** | scrypt N=2¹⁵ (`password.util.ts:17-24`), HS256 JWT with alg-pinning + timing-safe compare (`jwt.util.ts:56-79`), TOTP 2FA (`totp.service.ts`), session revocation via `sid` (`auth.service.ts:513-520`), brute-force rate-limit (`shared/http/auth-rate-limit.ts`). Gap: 2FA is opt-in, no MFA-enforcement policy. |
| **8.6** | Capacity management | **Partial** | prom-client `/metrics` + `/stats` exist (`modules/metrics`); resource limits only on ingress/egress (`docker-compose.yml:82-83,121-122`), none on core/redis/livekit; capacity ceiling per node **unmeasured** (§3.3). |
| **8.7** | Protection against malware | **Partial** ⬆ (2026-07-06) | SCA now gates CI: `sca:npm` fails the pipeline on HIGH+ advisories in the prod trees of core/web/adaptor and `sca:pip` audits the python workers' resolved trees (`.gitlab-ci.yml:142,164`), incl. a weekly scheduled sweep. Remaining: no container-image scanning (Trivy/Grype) and base images still float (`docker-compose.yml:76,102`, P1-6). |
| **8.8** | Management of technical vulnerabilities | **Partial** ⬆ (2026-07-06) | **0 npm advisories** across core/web/adaptor (was 10 high/15 mod/3 low): NestJS 10→11 wave, nodemailer ^9.0.3, uuid ^11, multer 2.2.0 + esbuild ^0.28.1 overrides (`streamhub-core/package.json`, `streamhub-adaptor/package.json`); `npm audit --omit=dev --audit-level=high` + `pip-audit` gate every MR/main run and a weekly schedule (`.gitlab-ci.yml:142,164`). Remaining: python deps not hash-pinned (P3-4), no documented remediation SLA (org policy). |
| **8.9** | Configuration management | **Partial** | All config is one commented `.env` + per-app `config.yaml` with timestamped backups (`apps.controller.ts:205-260`); idempotent migrations with a `VACUUM INTO` backup (`db.service.ts:214`). Gap: base images not pinned to digests; no config-drift detection across a fleet. |
| **8.10** | Information deletion | **Supports** | `POST /apps/:app/db/purge` cascades VOD deletion to S3 + local files (`db-admin.controller.ts:98-145`); log retention purge (`logs.service.ts:289-292`). Gap: no tenant-facing "right-to-erasure" workflow/record. |
| **8.11** | Data masking | **Partial** | `GET /system/settings` returns config with **every secret redacted** (`system.controller.ts:70-73`); logs avoid secrets (cluster join "NEVER log the cluster token or apiSecret", `cluster.service.ts:187`). No PII-masking framework. |
| **8.12** | Data leakage prevention | **Partial** | Tokens stored as sha256 only (`auth.service.ts:576-582`); TOTP secret AES-256-GCM at rest (`secret-cipher.util.ts`); secrets store chmod 600. Gap: **4 tenant-reachable SSRF egress vectors** (A01) are a data-exfil/leak path; `Access.md` holds PROD secrets in cleartext on disk. |
| **8.13** | Information backup | **Gap** | Migrations take a one-off pre-change backup, but there is **no automated, scheduled, restore-tested backup** of `DATA_DIR` (§3.3 blocker). An auditor will require evidence of successful restores. **Blocker for 8.13.** |
| **8.14** | Redundancy of information processing | **Gap** | Single node = SPOF; cluster is a registry without media routing (§3.2); no HA. Customer needing availability guarantees cannot meet this with the current topology. |
| **8.15** | Logging | **Supports** ⬆ (2026-07-06) | Structured security audit trail shipped: append-only `audit_log` in the global DB — UPDATE/DELETE rejected by SQLite triggers (`modules/audit/audit.service.ts:420,447`), per-row sha256 hash chain (`:244`) with a verification endpoint, `{actor, action, target, tenant, ip, ts, result}` on every security event (login/signup ±, token mint/revoke, `authz.deny` from `permission.guard.ts:140`, config/S3/MQTT changes, db purge, IP rules, moderation). Read API `GET /system/audit` (+`/verify`, superadmin — `audit.controller.ts:42,88`); retention env-configurable, default 90 d (`audit.service.ts:200`; set ≥365 for ISO scope). Plus the pre-existing `server_logs` + rotating files. Remaining (I-2): ship the trail off-box to a WORM sink — in-DB copy is root-deletable. |
| **8.16** | Monitoring activities | **Partial** ⬆ (2026-07-06) | prom-client metrics; NEW: auth failures + RBAC denials now land in the queryable audit trail (spike review is possible), and `GET /system/compliance` (`modules/audit/compliance.controller.ts:33`) reports live control posture (10 controls → state → §8 mapping) as auditor evidence + dashboard panel. Remaining: **alerting is designed but not deployed** (§3.3); no automated anomaly/spike alerting. |
| **8.17** | Clock synchronization | **Partial** | Timestamps use server time / SQLite `datetime('now')`; no explicit NTP assertion documented (host-level, usually fine on cloud VMs). |
| **8.18** | Use of privileged utility programs | **Partial** | `POST /admin/restart` gated to global-scope tokens, unit name from operator env (`admin.controller.ts:48-58`). Containers run as **root** under `network_mode: host` (A02). |
| **8.19** | Software on operational systems | **Partial** | One-image deploy, idempotent installer; but images float and installer is unverified (A03/A08). |
| **8.20** | Networks security | **Supports** | In-app IP allow/blocklist + auto-ban middleware (`modules/security/security.middleware.ts`); Caddy TLS termination, `/rtc` split, `/metrics` 403 externally (`deploy/Caddyfile`). Gap: XFF spoofable defeats the IP layer (A07). |
| **8.21** | Security of network services | **Partial** | Auto-TLS, per-app ingress auth (scrypt), signed webhooks. Gap: single LiveKit key = one trust root (A06). |
| **8.22** | Segregation of networks | **Partial** | Per-app SQLite + physical dir isolation; but `network_mode: host` on all services removes container network segregation. |
| **8.23** | Web filtering | **Gap** | No egress filtering / allow-listing (this is the SSRF gap from the outbound side, A01). |
| **8.24** | Use of cryptography | **Supports** | scrypt, AES-256-GCM at rest, HMAC-SHA256 webhooks, sha256 token hashing, TLS in transit. Gap: **no key-rotation / crypto-management policy** (single static JWT secret). |
| **8.25** | Secure development lifecycle | **Partial** | Clean parametrized SQL, 682+ tests, JSDoc, fail-closed patterns (§3.2); but **no CI security gate, no threat-model doc, no dependency policy**. |
| **8.26** | Application security requirements | **Partial** | This `security/` folder + tests catalogue is the start of documented requirements; SSRF/audit gaps remain. |
| **8.27** | Secure system architecture | **Supports** | Documented, honest architecture (`ARCHITECTURE.md`); DI-token decoupling; per-app isolation. |
| **8.28** | Secure coding | **Supports** | Parametrized SQL verified (A05), `execFile` no-shell, ValidationPipe whitelist, timing-safe comparisons. |
| **8.29** | Security testing in development | **Partial** | Rich unit/e2e suite (`streamhub-docs/testing/UNIT-TESTS.md`), shellcheck in CI; **no SAST/DAST/dependency-scan**. |
| **8.30** | Outsourced development | n/a | Organisational. |
| **8.31** | Separation of dev/test/prod | **Partial** | Test env fully mocked, no infra needed (CLAUDE.md); but prod deploy = a local unversioned script with hardcoded secrets (`deploy-streamhub.sh`, §3.3). |
| **8.32** | Change management | **Partial** | Idempotent migrations + config backups; `.gitlab-ci.yml` build/test gate. Gap: no documented change-approval / release-signing (A08). |
| **8.33** | Test information | **Supports** | Tests use synthetic fixtures/mocks, no prod data (CLAUDE.md testing section). |
| **8.34** | Protection of systems during audit | n/a | Organisational. |

### §8 scorecard

**Supports 9 · Partial 18 · Gap 4 · n/a 3** *(updated 2026-07-06; was Supports 8
· Partial 17 · Gap 6).* The product is genuinely helpful on access control
(8.3/8.5), cryptography (8.24/8.28), secure architecture (8.27) and — new — the
security audit trail (8.15). The **remaining hard gaps (8.13 backups, 8.14
redundancy, 8.23 egress filtering)** plus the alerting half of 8.16 are what an
ISO auditor probes next; 8.7/8.8 moved to Partial with the CI SCA gate and a
zero-advisory dependency tree, pending container scanning + a documented
remediation SLA. (Backups 8.13 and the SSRF/egress work are in flight in the
parallel security-fixes/backups workstreams.)

---

## Part 2 — Product gaps that would block a customer's ISO audit

Each gap below is something a customer's auditor would raise as a nonconformity when
StreamHub is in scope. The **feature** column is what the product must add; these are
carried into `FIX-BACKLOG.md`.

| # | Control(s) | Gap in the product | Feature needed |
|---|---|---|---|
| I-1 | 8.15, 8.16, 5.28 | ~~No structured, tamper-evident **security audit trail**~~ **CLOSED (product) 2026-07-06** — append-only, hash-chained `audit_log` records token create/revoke, config/S3/MQTT change, `db/purge`, login/signup success+failure, permission DENY, IP-rule change and moderation as `{actor, action, target, tenant, ip, ts, result}` (`streamhub-core/src/modules/audit/`); queryable via `GET /system/audit` + dashboard Audit page; retention `STREAMHUB_AUDIT_RETENTION_DAYS` (90 d default). Auth-service-internal events (magic-link consume, session revoke, TOTP toggle) still pending wiring — see the security-fixes handoff. | ~~Append-only `audit_log`~~ Done; extend wiring into `auth.service.ts` / backups module when those files unlock. |
| I-2 | 8.15 | **Log immutability & retention.** `server_logs` is in the app's own SQLite (deletable by a core RCE), retention default 30d, no off-box shipping. | Ship logs to an immutable/WORM sink (syslog/OTLP); configurable retention ≥12 months. |
| I-3 | 8.2, 8.3, 5.18 | **No access-review evidence.** No report of "who has which role in which tenant," no periodic recertification. | Access-review export (users × roles × tenants × last-used) + a recertify workflow. |
| I-4 | 8.24 | **No key rotation.** Single static `STREAMHUB_JWT_SECRET`; TOTP key derived from it; single LiveKit key for all tenants. | Keyed JWT rotation (`kid`), per-node/tenant LiveKit keys with a rotatable master, documented rotation runbook. |
| I-5 | 8.13 | **No automated, restore-tested backups** of `DATA_DIR`. | Scheduled versioned backups (Litestream or `VACUUM INTO`→S3) with a rehearsed, evidenced restore. |
| I-6 | 8.7, 8.8 | **MOSTLY CLOSED (product) 2026-07-06** — was: 10 high npm advisories shipped, no SCA. Now: **0 npm advisories** in core/web/adaptor (NestJS 11 wave + nodemailer 9 + multer/esbuild overrides) and `sca:npm`/`sca:pip` CI gates + weekly scheduled sweep (`.gitlab-ci.yml`). Remaining: Trivy/Grype container scan, hash-pinned python (P3-4), digest-pinned images (P1-6), documented remediation SLA (org). | Container scan in CI + image digests + SLA doc. |
| I-7 | 8.12, 8.23, A01 | **SSRF egress paths** (callbacks, S3 endpoint, MQTT, URL-ingress) are a data-leak channel with no allow-listing. | Central egress SSRF guard (private-IP/scheme block + DNS-rebinding defense). |
| I-8 | 8.28, 8.20 | **X-Forwarded-For trusted blindly** — defeats the per-token IP allowlist and the auto-ban, and lets `127.0.0.1` bypass network security. | Resolve client IP from the proxy-validated `req.ip`, never raw `XFF[0]`. |
| I-9 | 8.9, 8.19, 8.32 | **Installer/artifact integrity** — unsigned, unpinned `curl\|sudo bash`; sha256 published but unconsumed. | Consume the existing sha256 + add a detached signature (minisign/cosign); pin `git clone --branch <tag>`. |
| I-10 | 8.14 | **No redundancy/HA** — single node SPOF, cluster does not route media. | Real multi-node media routing + upgrade-without-downtime (roadmap `C-01/C-02`). |
| I-11 | 8.18, 8.22 | **Root containers on host network** — no least-privilege, no network segregation. | Non-root core user + per-service resource limits + digest-pinned images. |

---

## Part 3 — Roadmap: what the ORGANISATION (not the code) must add

Even with every product gap above closed, certification requires an ISMS. This is
company work, not repo work:

1. **Define ISMS scope & context** (Clause 4) — which entity, which services (the
   managed-hosting offering), which locations/cloud accounts. Note the AWS PROD
   account separation already tracked in ops memory belongs here.
2. **Leadership & policy** (Clause 5) — an approved Information Security Policy,
   assigned roles (a security owner), and management commitment.
3. **Risk assessment & treatment** (Clause 6 / 8) — a **risk register** and a
   documented methodology; a **Statement of Applicability (SoA)** justifying each of
   the 93 Annex A controls as applicable/excluded, referencing the §8 mapping above
   as the technical evidence base.
4. **Support** (Clause 7) — competence/awareness records, documented information
   control (this `security/` folder is a good start), supplier register (LiveKit,
   AWS, the SMTP provider, DO/marketplace).
5. **Operation** (Clause 8) — run the treatment plan; operate the controls; keep
   records (backup-restore tests, access reviews, vuln-scan results, incident logs).
6. **Performance evaluation** (Clause 9) — internal audit programme + management
   review meetings with minutes.
7. **Improvement** (Clause 10) — corrective-action / nonconformity log.
8. **Supporting operational docs** an auditor expects: **incident-response plan**,
   **business-continuity/DR plan** (ties to I-5/I-10), **secure-SDLC policy** (ties
   to I-6), **access-control policy** (ties to I-3), **cryptographic-key-management
   policy** (ties to I-4), **supplier-security policy**.

**Realistic sequence:** close product gaps I-1, I-2, I-3, I-5, I-8, I-9 (the
audit-trail, backups, access reviews, IP-trust, installer integrity — mostly
S/M effort) → stand up the ISMS documentation set → run 3–6 months of records →
internal audit → Stage 1 (documentation) then Stage 2 (implementation) external
audit. Certification is typically **9–15 months** of organisational effort once the
product gaps are closed, with a Stage 1/Stage 2 audit split.

---

## Bottom line

- **"Can StreamHub be ISO 27001 certified?"** — Not as a product; ISO 27001 certifies
  the operating company's ISMS. StreamHub can become **"ISO-ready"** so it doesn't
  block that certification.
- **How ready is it today?** *(updated 2026-07-06)* The product **supports** the
  core §8 access-control, cryptography, secure-architecture controls AND now the
  security **audit trail** (8.15 — append-only hash-chained `audit_log` + query
  API + dashboard viewer). Vulnerability management moved to Partial: **0 npm
  advisories** shipped and an SCA gate + weekly sweep in CI (8.7/8.8). A live
  **compliance posture endpoint** (`GET /system/compliance` + dashboard panel)
  gives auditors per-control evidence. Remaining hard gaps: tested backups 8.13,
  redundancy 8.14, egress filtering 8.23 (SSRF) and XFF-trust — the P0/P1 items
  in `FIX-BACKLOG.md`, several in flight in parallel workstreams.
- **What's still missing beyond code** — an actual ISMS: policies, a risk register +
  SoA, and an internal-audit programme. That is organisational work no code change
  can substitute for.

**Sources:** ISO/IEC 27001:2022 (ISMS requirements) · ISO/IEC 27002:2022 (93 controls
in 4 themes; §8 = 34 technological controls) · cross-referenced with
`OWASP-TOP10-ASSESSMENT.md`.
