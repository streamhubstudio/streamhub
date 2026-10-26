#!/usr/bin/env node
/**
 * Production smoke suite — exercises every major API surface against a LIVE
 * StreamHub, read-only where possible and REVERSIBLE where not (it creates a
 * throwaway `smoke-<ts>` app, probes it, and deletes it in a finally block).
 * Safe to run against prod on a schedule or on demand.
 *
 *   STREAMHUB_BASE=https://app.streamhub.studio \
 *   STREAMHUB_TOKEN=sk_... \
 *   node scripts/prod-smoke.mjs
 *
 * Exit 0 = all checks passed; 1 = one or more failed (details printed).
 * Covers: health/version, auth/RBAC, the Studio taxonomy (kind/exportable),
 * export bundle, passthrough ingress, tags CRUD, per-app net metrics, edge
 * nodes, vision overview, cluster nodes. Add a check when you ship a surface.
 */
const BASE = (process.env.STREAMHUB_BASE || 'http://127.0.0.1:3020').replace(/\/+$/, '')
const TOKEN = process.env.STREAMHUB_TOKEN
if (!TOKEN) { console.error('STREAMHUB_TOKEN required'); process.exit(2) }

const API = `${BASE}/api/v1`
let pass = 0, fail = 0
const fails = []

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name} ${detail}`) }
}

async function api(method, path, body, raw = false) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return res
  let json = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, json }
}

async function main() {
  const app = `smoke${Date.now().toString(36)}`
  console.log(`StreamHub prod-smoke → ${BASE} (test app: ${app})\n`)

  // 1. health + version
  const h = await fetch(`${BASE}/api/v1/health`).then((r) => r.json()).catch(() => null)
  ok('health up', h && h.up === true)
  ok('version present', h && typeof h.version === 'string', h?.version)

  // 2. auth: token works; a bad token is rejected
  ok('token authorized (GET /apps 200)', (await api('GET', '/apps')).status === 200)
  const bad = await fetch(`${API}/apps`, { headers: { Authorization: 'Bearer sk_invalid' } })
  ok('bad token rejected (401)', bad.status === 401)

  try {
    // 3. create throwaway app
    const created = await api('POST', '/apps', { name: app })
    ok('create app (201)', created.status === 201)

    // 4. Studio taxonomy: catalog carries kind/exportable/version
    const cat = await api('GET', `/apps/${app}/plugins`)
    const metas = (cat.json?.data || []).map((x) => x.manifest || x)
    const apps = metas.filter((m) => m.kind === 'app')
    const plugins = metas.filter((m) => m.kind === 'plugin')
    ok('catalog has kind=app entries', apps.length >= 8, `apps=${apps.length}`)
    ok('catalog has kind=plugin entries', plugins.length >= 5, `plugins=${plugins.length}`)
    ok('all metas carry a semver version', metas.every((m) => /^\d+\.\d+\.\d+$/.test(m.version || '')))
    ok('exportable flag present on apps', metas.some((m) => m.exportable === true))

    // 5. install an exportable app + export bundle
    const exp = metas.find((m) => m.exportable)
    if (exp) {
      await api('POST', `/apps/${app}/plugins/${exp.id}/install`)
      const bundle = await api('GET', `/apps/${app}/plugins/${exp.id}/export`, undefined, true)
      const ct = bundle.headers.get('content-type') || ''
      ok(`export ${exp.id} → gzip (200)`, bundle.status === 200 && ct.includes('gzip'), `${bundle.status} ${ct}`)
    } else ok('an exportable app exists', false)

    // 6. passthrough ingress (reversible — deleted with the app)
    const ing = await api('POST', `/apps/${app}/ingress`, { inputType: 'rtmp', mode: 'passthrough', room: `${app}-cam` })
    const rurl = ing.json?.data?.rtmp_url || ing.json?.data?.rtmpUrl
    ok('passthrough ingress created', ing.status < 300 && typeof rurl === 'string', `${ing.status}`)

    // 7. tags CRUD
    const tag = await api('POST', `/apps/${app}/tags`, { slug: 'smoke-zone', label: 'Smoke', kind: 'custom' })
    ok('tag create', tag.status < 300, `${tag.status}`)
    ok('tag list', (await api('GET', `/apps/${app}/tags`)).status === 200)
    ok('tag delete', (await api('DELETE', `/apps/${app}/tags/smoke-zone`)).status < 300)

    // 8. per-app net metrics
    ok('net summary endpoint', (await api('GET', `/apps/${app}/net`)).status === 200)

    // 9. vision apps (2.16.0: vision split into 4 edge-capable Studio Apps)
    const visionApps = ['occupancy', 'counting', 'crowd', 'demography']
    ok('4 vision apps in catalog', visionApps.every((id) => metas.some((m) => m.id === id && m.kind === 'app')))
    ok('edge flag on manifests', metas.some((m) => m.edge === true) && metas.some((m) => m.id === 'transcription' && !m.edge))
    ok('occupancy overview endpoint', [200, 404].includes((await api('GET', `/apps/${app}/plugins/occupancy/overview`)).status))

    // 9b. generic per-app edge assignments API (2.16.0)
    ok('edge assignments list', (await api('GET', `/apps/${app}/edge/assignments`)).status === 200)

    // 9c. appstore (2.19.0): versions catalog carries the materialized builtin.
    // deface is a DECOUPLED app — this doubles as the COMPOSITION SENTINEL: a
    // deploy that skipped apps-pull ships no vendored apps and must FAIL here
    // (never silently lose the 8 decoupled apps). Same for the transcription
    // edge-flag probe above.
    const vers = await api('GET', `/plugins/deface/versions`)
    ok('appstore versions + builtin (composition sentinel)', vers.status === 200 && (vers.json?.data?.versions || []).some((v) => v.builtin === true), `${vers.status}`)

    // 10. streamflow (2.15.0): box catalogue served + workflow CRUD (reversible)
    const boxes = await api('GET', `/apps/${app}/plugins/streamflow/boxes`)
    ok('streamflow box catalogue', boxes.status === 200 && (boxes.json?.data || []).length > 0, `${boxes.status}`)
    const wf = await api('POST', `/apps/${app}/plugins/streamflow/workflows`, {
      name: 'smoke-wf',
      graph: {
        boxes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'b', type: 'action.emit', config: { event: 'smoke.ping' } }],
        edges: [{ from: 'a', to: 'b' }],
      },
    })
    ok('streamflow workflow create', wf.status < 300, `${wf.status}`)
    const wfId = wf.json?.data?.id
    ok('streamflow workflow delete', !wfId || (await api('DELETE', `/apps/${app}/plugins/streamflow/workflows/${wfId}`)).status < 300)

    // 11. cluster + edge nodes (global)
    ok('cluster nodes list', (await api('GET', '/cluster/nodes')).status === 200)
    const edge = await api('GET', '/edge/nodes')
    ok('edge nodes list', edge.status === 200)
    const origin = (edge.json?.data || []).find((n) => n.name === 'origin')
    ok('origin node present + reports disk', !!origin?.stats?.disk, JSON.stringify(origin?.stats?.disk || null))
  } finally {
    // cleanup: delete the throwaway app no matter what
    const del = await api('DELETE', `/apps/${app}`)
    ok('cleanup: test app deleted', del.status < 300, `${del.status}`)
  }

  console.log(`\n${pass} passed, ${fail} failed${fail ? ' → ' + fails.join(', ') : ''}`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('smoke crashed:', e.message); process.exit(1) })
