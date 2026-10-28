/**
 * Fast logic suite (node:test) for the fleet plugin's pure helpers — runs in
 * the default `npm test` (node --test, TS type-stripping). Covers response
 * parsing, filtering/counts, the human formatters and the sparkline math.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentCounts,
  filterAgents,
  formatAge,
  formatPercent,
  formatTemp,
  formatUptime,
  parseAgents,
  sparklinePoints,
  type AgentView,
} from './logic.ts'

function agent(id: string, online: boolean): AgentView {
  return {
    agentId: id,
    online,
    status: online ? 'online' : 'offline',
    version: '1.12',
    lastSeen: '',
    ageMs: 1000,
    metrics: { cpu: 10, mem: 20, temp: 40, uptime: 60, cameras: 1, disk: 30, battery: null, relay: 'running' },
  }
}

test('parseAgents coerces + drops junk', () => {
  const r = parseAgents({
    agents: [
      { agentId: 'a', online: true, status: 'online', metrics: { cpu: 5 } },
      { online: true }, // no id → dropped
      'nope',
    ],
    generatedAt: 'x',
  })
  assert.equal(r.agents.length, 1)
  assert.equal(r.agents[0].agentId, 'a')
  assert.equal(r.agents[0].metrics.cpu, 5)
  assert.equal(r.agents[0].metrics.mem, null)
  assert.equal(r.agents[0].metrics.battery, null) // AC-only host: absent, not 0
})

test('parseAgents keeps a reported battery', () => {
  const r = parseAgents({ agents: [{ agentId: 'cam', metrics: { battery: 42 } }] })
  assert.equal(r.agents[0].metrics.battery, 42)
})

test('parseAgents tolerates a missing/garbage body', () => {
  assert.deepEqual(parseAgents(undefined).agents, [])
  assert.deepEqual(parseAgents({ agents: 'no' }).agents, [])
})

test('filterAgents + agentCounts', () => {
  const list = [agent('a', true), agent('b', false), agent('c', true)]
  assert.deepEqual(agentCounts(list), { all: 3, online: 2, offline: 1 })
  assert.equal(filterAgents(list, 'online').length, 2)
  assert.equal(filterAgents(list, 'offline').length, 1)
  assert.equal(filterAgents(list, 'all').length, 3)
})

test('formatUptime', () => {
  assert.equal(formatUptime(null), '—')
  assert.equal(formatUptime(45), '45s')
  assert.equal(formatUptime(600), '10m')
  assert.equal(formatUptime(3 * 3600 + 12 * 60), '3h 12m')
  assert.equal(formatUptime(2 * 86400 + 4 * 3600), '2d 4h')
})

test('formatPercent / formatTemp / formatAge', () => {
  assert.equal(formatPercent(null), '—')
  assert.equal(formatPercent(42.4), '42%')
  assert.equal(formatTemp(46.6), '47°C')
  assert.equal(formatAge(3000), '3s')
  assert.equal(formatAge(120000), '2m')
})

test('sparklinePoints scales into the box + handles edge cases', () => {
  assert.equal(sparklinePoints([]), '')
  assert.equal(sparklinePoints([5], 120, 32), '2,16 118,16') // single point → flat mid line
  const pts = sparklinePoints([0, 10], 120, 32, 2)
  const coords = pts.split(' ')
  assert.equal(coords.length, 2)
  // min maps to bottom (y=h-pad=30), max to top (y=pad=2)
  assert.ok(coords[0].endsWith(',30'))
  assert.ok(coords[1].endsWith(',2'))
})
