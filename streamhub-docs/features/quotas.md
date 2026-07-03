# Quotas (per-tenant)

## What it does

Every team (tenant) has quota limits. Enforcement happens in the controllers
**before** the costly action (create app / open stream / start recording /
start egress). Usage is counted from the registry + per-app DBs + a
`quota_usage` table.

**Phased enforcement** via `STREAMHUB_AUTHZ_ENFORCE` (same flag as authz):
- `off` — no checks.
- `log` (default) — counts and logs a "QUOTA-WOULD-DENY" but allows.
- `on` — rejects over-quota requests with **HTTP 429** `{ error:"quota_exceeded", metric, limit, used }`.

**Never quota-limited:** superadmin, `api_token` principals, and unscoped
credentials (no tenantId). A metric with limit `-1` = unlimited.

## Metrics & free-plan defaults

| Metric | Free default | Enforced before |
|--------|-------------|-----------------|
| `maxApps` | 2 | `POST /apps` |
| `maxConcurrentStreams` | 2 | mint publisher token, `POST /apps/:app/ingress` |
| `maxRecordingMinutesMonth` | 300 | `POST .../recording/start`, `.../record/start` |
| `maxEgressGbMonth` | 5 | `POST /apps/:app/broadcast/start` |
| `maxStorageGb` | 5 | (reported; storage accounting) |

Per-tenant overrides live in the `quotas` table (one column per metric);
`tenants.plan` names the plan. Defaults apply when no row exists.

## Endpoint

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/tenants/:id/usage` | usage:read | Usage vs limits for a tenant |

A non-superadmin, non-api_token caller may only read **its own** tenant's usage
(else 403). The same report is embedded in `GET /teams/mine`.

### Response — UsageReport

```json
{ "data": {
  "tenantId": "ten_...",
  "plan": "free",
  "quotas": {
    "maxApps": 2, "maxConcurrentStreams": 2,
    "maxRecordingMinutesMonth": 300, "maxEgressGbMonth": 5, "maxStorageGb": 5
  },
  "usage": {
    "apps": 1, "concurrentStreams": 0,
    "recordingMinutesMonth": 12, "egressGbMonth": 0.4, "storageGb": 1.1
  },
  "exceeded": { "apps": false, "concurrentStreams": false,
    "recordingMinutesMonth": false, "egressGbMonth": false, "storageGb": false }
}, "error": null }
```

## Example

```bash
curl -s $BASE/tenants/ten_abc/usage -H "Authorization: Bearer $JWT"
```

## Notes

- Concurrent streams are counted as `streams.status='active'` across all the
  tenant's per-app DBs.
- The service is **defensive** about schema: missing tables/columns degrade to
  "unlimited / zero usage" rather than throwing, so a partially-migrated deploy
  never blocks traffic.
- Quotas and usage are also exported to Prometheus (`streamhub_tenant_quota`,
  `streamhub_tenant_usage`).
</content>
