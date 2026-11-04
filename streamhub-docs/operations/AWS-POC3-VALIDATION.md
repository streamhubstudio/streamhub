# AWS PoC3 — real-box validation (Debian installer · RTMPS · multi-tenant)

**Date:** 2026-07-06 · **Account:** shared (us-east-1) · **Tag:** `Project=streamhub-poc3`
· **Box:** Debian 12 (bookworm), `c5.xlarge` **spot**, 30 GB gp3, AMI `ami-00674cb2272505e3c`
· **Source:** the merged repo built into a tarball (`streamhub-2.2.0.tar.gz`) and fed to the installer
via `STREAMHUB_SRC_URL=file://…` (the private-repo git clone falls back to the tarball) · **Domain:**
`localhost` (self-signed, no ACME). **Full teardown + zero-audit done afterward — nothing billing.**

## 1. Debian installer — PASS (end-to-end)

- OS gate accepted Debian: `OS check: Debian 12 (bookworm) x86_64`.
- apt dependency install + Docker installed via `get.docker.com` (auto-selected the **debian** repo).
- Docker images built on the box: `streamhub-core:local` (multi-stage on **node:24**), plus
  `livekit-server:v1.8.4`, `ingress`, `egress`, `redis:7-alpine`.
- All 5 services up; **`streamhub-core` reported `healthy`**; `GET /api/v1/health` → `{"status":"ok","up":true}`.
- Anonymous install ping sent (`mode=fresh, version=2.2.0, arch=amd64`).
- Confirms the C4 change (installer OS-gate accepts `debian` 12/13) works on a real Debian host.

## 2. Multi-tenant isolation (C11) — PASS (with `STREAMHUB_AUTHZ_ENFORCE=on`)

Created two apps (`tenanta` id 2, `tenantb` id 3) with the global `sk_` token, then minted an
**app-scoped** token for `tenanta` (`POST /tokens {scope:"app", appId:2}`) and ran the cross-tenant
matrix:

| Request (appA-scoped token) | Result | Expected |
|---|---|---|
| `GET /apps/tenanta` (own) | **200** | 200 |
| `GET /apps/tenantb` (cross) | **403** | 403 |
| `GET /apps/tenantb/s3` (cross) | **403** | 403 |
| `POST /apps/tenantb/db/purge` (cross) | **403** | 403 |
| `GET /apps/tenanta/s3` (own) | **200** | 200 |
| `GET /apps/tenantb` (global token, control) | **200** | 200 |

The P0 tenant-isolation (closed in code + unit-locked) is now **proven on a running install** — an
app-scoped token cannot read, read-S3, or purge another tenant. Note: enforcement depends on
`AUTHZ_ENFORCE=on` (the fresh-install default). In `log` mode the guard would allow-and-log — so prod
(`media01`) must be on `on` for the same guarantee.

## 3. RTMPS ingest (C8) — PASS (end-to-end)

- Enabled `STREAMHUB_RTMPS_ENABLE=true` + a self-signed cert in `data/certs/rtmps/`, started the
  `rtmps` compose profile → `streamhub-rtmps` (stunnel 5.72) up on `:1936`.
- TLS handshake on `:1936` served the cert (`subject=CN=localhost`).
- The ingress API returned **both** URLs, same path/key, scheme+port swapped:
  `rtmp://…:1935/live/<key>` **and** `rtmps://…:1936/live/<key>`.
- Pushed a `testsrc` over `rtmps://…:1936/live/<key>` with ffmpeg (`-tls_verify 0` for the self-signed
  cert). stunnel logs: `accepted connection … s_connect: connected 127.0.0.1:1935 … connected remote
  server`. LiveKit ingress: `relaying ingress … StreamName = <key>`. The stream went **live**:
  `GET /apps/tenanta/streams` → `[{type:"rtmp", room:"tenanta", status:"active"}]`.
- Confirms the full path: ffmpeg `rtmps://` → stunnel TLS-terminate `:1936` → forward `:1935` →
  LiveKit ingress → live stream.

## Notes / follow-ups
- Minor: `$INSTALL_DIR/VERSION` was empty after install (health reports the package version `0.1.0`,
  not the release `2.2.0`); the anonymous ping still reported `version=2.2.0` from the fetched source.
  Worth reconciling the VERSION stamp path (cosmetic; does not affect operation).
- stunnel logged a benign dual-stack double-bind warning (`Binding … :::1936: Address in use`) while
  still serving `:1936` correctly — cosmetic.
- A production RTMPS client that verifies certs needs a real (non-self-signed) cert; point
  `STREAMHUB_RTMPS_CERT_DIR` at the ACME/`certbot` live dir (documented in ENV.md).

## Teardown (verified zero-audit)
Instance `terminated`, spot request `cancelled`, 0 volumes, key pair `sh-poc3` deleted, security group
deleted, no snapshots. No S3/Route53 created for this run. Estimated spend: a few US cents (one
c5.xlarge spot for ~1 h).
