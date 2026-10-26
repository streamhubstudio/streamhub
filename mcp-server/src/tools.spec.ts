/**
 * Tool catalogue specs: registry invariants, the destructive gate, and the
 * complete tool→endpoint mapping (every tool exercised against a fake client
 * that records method/path/query/body — no MCP plumbing, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpClient, Query } from './client.ts';
import { buildTools, TOOLS, type ToolDef } from './tools.ts';

interface Call {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

class FakeClient implements HttpClient {
  calls: Call[] = [];

  private record(call: Call): Promise<unknown> {
    // Drop undefined query values so expectations stay literal.
    if (call.query) {
      const q: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(call.query)) if (v !== undefined && v !== null) q[k] = v;
      call.query = Object.keys(q).length > 0 ? q : undefined;
    }
    if (call.query === undefined) delete call.query;
    if (call.body === undefined) delete call.body;
    this.calls.push(call);
    return Promise.resolve({ ok: true });
  }

  get(path: string, opts?: { query?: Query }): Promise<unknown> {
    return this.record({ method: 'GET', path, query: opts?.query });
  }
  post(path: string, body?: unknown, opts?: { query?: Query }): Promise<unknown> {
    return this.record({ method: 'POST', path, body, query: opts?.query });
  }
  patch(path: string, body?: unknown): Promise<unknown> {
    return this.record({ method: 'PATCH', path, body });
  }
  put(path: string, body?: unknown): Promise<unknown> {
    return this.record({ method: 'PUT', path, body });
  }
  del(path: string, opts?: { query?: Query }): Promise<unknown> {
    return this.record({ method: 'DELETE', path, query: opts?.query });
  }
}

function toolByName(name: string): ToolDef {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} not found`);
  return tool;
}

async function run(name: string, args: Record<string, unknown>): Promise<Call> {
  const client = new FakeClient();
  await toolByName(name).handler(client, args as Record<string, any>);
  assert.equal(client.calls.length, 1, `${name} must make exactly one HTTP call`);
  return client.calls[0]!;
}

// ── Registry invariants ─────────────────────────────────────────────────────

test('registry: names are unique and snake_case', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  for (const n of names) assert.match(n, /^[a-z][a-z0-9_]*$/, `bad tool name: ${n}`);
});

test('registry: every tool has title, description (with its endpoint) and schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.title.length > 0, `${t.name}: empty title`);
    assert.ok(t.description.length > 20, `${t.name}: description too short`);
    assert.match(t.description, /\/api\/v1\//, `${t.name}: description must cite its endpoint`);
    assert.ok(t.inputSchema, `${t.name}: missing inputSchema`);
    assert.equal(typeof t.handler, 'function');
  }
});

test('registry: exactly the clearly-destructive ops are gated', () => {
  const gated = TOOLS.filter((t) => t.destructive).map((t) => t.name).sort();
  assert.deepEqual(gated, ['delete_app', 'delete_vod', 'purge_app_db']);
});

test('buildTools: destructive tools are omitted by default, present when allowed', () => {
  const safe = buildTools({ allowDestructive: false }).map((t) => t.name);
  assert.ok(!safe.includes('delete_app'));
  assert.ok(!safe.includes('delete_vod'));
  assert.ok(!safe.includes('purge_app_db'));
  assert.equal(safe.length, TOOLS.length - 3);

  const all = buildTools({ allowDestructive: true }).map((t) => t.name);
  assert.equal(all.length, TOOLS.length);
  assert.ok(all.includes('delete_app'));
});

test('registry: read-only tools carry readOnlyHint; gated ones carry destructiveHint', () => {
  for (const t of TOOLS) {
    if (t.destructive) {
      assert.equal(t.annotations?.destructiveHint, true, `${t.name}: missing destructiveHint`);
      assert.ok('confirm' in t.inputSchema, `${t.name}: destructive tool must require confirm`);
    }
    if (t.annotations?.readOnlyHint) {
      assert.equal(t.annotations.destructiveHint, undefined, `${t.name}: contradictory hints`);
    }
  }
});

// ── Destructive confirmation gate ───────────────────────────────────────────

test('destructive handlers refuse to run without confirm: true', async () => {
  const client = new FakeClient();
  for (const [name, args] of [
    ['delete_app', { name: 'old' }],
    ['delete_vod', { app: 'live', id: 42 }],
    ['purge_app_db', { app: 'live', scope: 'logs' }],
  ] as const) {
    await assert.rejects(
      async () => await toolByName(name).handler(client, { ...args }),
      /not confirmed/i,
      `${name} must reject without confirm`,
    );
  }
  assert.equal(client.calls.length, 0, 'no HTTP call may happen without confirmation');
});

// ── Tool → endpoint mapping (complete catalogue) ────────────────────────────

const MAPPING: Array<{ tool: string; args: Record<string, unknown>; expect: Call }> = [
  // system
  { tool: 'get_health', args: {}, expect: { method: 'GET', path: '/health' } },
  { tool: 'get_system_stats', args: {}, expect: { method: 'GET', path: '/stats' } },
  {
    tool: 'query_logs',
    args: { app: 'live', level: 'error', limit: 50 },
    expect: { method: 'GET', path: '/logs', query: { app: 'live', level: 'error', limit: 50 } },
  },
  // apps
  { tool: 'list_apps', args: {}, expect: { method: 'GET', path: '/apps' } },
  { tool: 'get_app', args: { name: 'live' }, expect: { method: 'GET', path: '/apps/live' } },
  {
    tool: 'create_app',
    args: { name: 'live', displayName: 'Live' },
    expect: { method: 'POST', path: '/apps', body: { name: 'live', displayName: 'Live' } },
  },
  {
    tool: 'update_app',
    args: {
      name: 'live',
      recordingEnabled: true,
      splitMinutes: 30,
      filenameTemplate: '${app}_${room}',
      snapshotTemplate: '${room}_snap',
      retentionDays: 30,
      variables: { site: 'HQ' },
    },
    expect: {
      method: 'PATCH',
      path: '/apps/live',
      body: {
        recordingEnabled: true,
        splitMinutes: 30,
        filenameTemplate: '${app}_${room}',
        snapshotTemplate: '${room}_snap',
        retentionDays: 30,
        variables: { site: 'HQ' },
      },
    },
  },
  {
    tool: 'get_app_stats',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/stats' },
  },
  {
    tool: 'get_app_sizes',
    args: { name: 'live' },
    expect: { method: 'GET', path: '/apps/live/sizes' },
  },
  {
    tool: 'delete_app',
    args: { name: 'old', deleteVods: true, confirm: true },
    expect: { method: 'DELETE', path: '/apps/old', query: { deleteVods: true } },
  },
  // presets
  { tool: 'list_presets', args: { app: 'live' }, expect: { method: 'GET', path: '/apps/live/presets' } },
  {
    tool: 'apply_preset',
    args: { app: 'live', preset: 'low-latency' },
    expect: { method: 'POST', path: '/apps/live/presets/low-latency/apply' },
  },
  {
    tool: 'deactivate_preset',
    args: { app: 'live', preset: 'low-latency' },
    expect: { method: 'POST', path: '/apps/live/presets/low-latency/deactivate' },
  },
  // streams
  {
    tool: 'list_streams',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/streams' },
  },
  {
    tool: 'get_stream',
    args: { app: 'live', id: 'live/cam-1' },
    expect: { method: 'GET', path: '/apps/live/streams/live%2Fcam-1' },
  },
  {
    tool: 'stop_stream',
    args: { app: 'live', id: 'live/cam-1' },
    expect: { method: 'DELETE', path: '/apps/live/streams/live%2Fcam-1' },
  },
  {
    tool: 'snapshot_stream',
    args: { app: 'live', id: 'live/cam-1' },
    expect: { method: 'POST', path: '/apps/live/streams/live%2Fcam-1/snapshot' },
  },
  {
    tool: 'snapshot_room',
    args: { app: 'live', room: 'demo' },
    expect: { method: 'POST', path: '/apps/live/snapshots', body: { room: 'demo' } },
  },
  // rooms
  { tool: 'list_rooms', args: { app: 'live' }, expect: { method: 'GET', path: '/apps/live/rooms' } },
  {
    tool: 'get_room',
    args: { app: 'live', room: 'demo' },
    expect: { method: 'GET', path: '/apps/live/rooms/demo' },
  },
  {
    tool: 'list_participants',
    args: { app: 'live', room: 'demo' },
    expect: { method: 'GET', path: '/apps/live/rooms/demo/participants' },
  },
  {
    tool: 'kick_participant',
    args: { app: 'live', room: 'demo', identity: 'user 1' },
    expect: { method: 'DELETE', path: '/apps/live/rooms/demo/participants/user%201' },
  },
  {
    tool: 'mute_participant',
    args: { app: 'live', room: 'demo', identity: 'u1', kind: 'audio', muted: true },
    expect: {
      method: 'POST',
      path: '/apps/live/rooms/demo/participants/u1/mute',
      body: { kind: 'audio', muted: true },
    },
  },
  {
    tool: 'update_room_metadata',
    args: { app: 'live', room: 'demo', metadata: '{"onAir":true}' },
    expect: {
      method: 'PATCH',
      path: '/apps/live/rooms/demo/metadata',
      body: { metadata: '{"onAir":true}' },
    },
  },
  {
    tool: 'send_room_data',
    args: { app: 'live', room: 'demo', topic: 'chat', message: 'hello', from: 'mod' },
    expect: {
      method: 'POST',
      path: '/apps/live/rooms/demo/data',
      body: { topic: 'chat', message: 'hello', from: 'mod' },
    },
  },
  // tags
  {
    tool: 'list_tags',
    args: { app: 'live', kind: 'store' },
    expect: { method: 'GET', path: '/apps/live/tags', query: { kind: 'store' } },
  },
  {
    tool: 'get_tag',
    args: { app: 'live', slug: 'store-downtown' },
    expect: { method: 'GET', path: '/apps/live/tags/store-downtown' },
  },
  {
    tool: 'create_tag',
    args: { app: 'live', slug: 'store-downtown', label: 'Downtown Store', kind: 'store' },
    expect: {
      method: 'POST',
      path: '/apps/live/tags',
      body: { slug: 'store-downtown', label: 'Downtown Store', kind: 'store' },
    },
  },
  {
    tool: 'update_tag',
    args: { app: 'live', slug: 'store-downtown', label: 'Downtown' },
    expect: { method: 'PATCH', path: '/apps/live/tags/store-downtown', body: { label: 'Downtown' } },
  },
  {
    tool: 'delete_tag',
    args: { app: 'live', slug: 'store-downtown' },
    expect: { method: 'DELETE', path: '/apps/live/tags/store-downtown' },
  },
  {
    tool: 'apply_room_tags',
    args: { app: 'live', room: 'demo', tags: ['store-downtown'] },
    expect: {
      method: 'PATCH',
      path: '/apps/live/tags/room/demo',
      body: { tags: ['store-downtown'] },
    },
  },
  {
    tool: 'get_stream_tags',
    args: { app: 'live', id: 'live/cam-1' },
    expect: { method: 'GET', path: '/apps/live/streams/live%2Fcam-1/tags' },
  },
  {
    tool: 'update_stream_tags',
    args: { app: 'live', id: 'live/cam-1', tags: ['store-downtown'] },
    expect: {
      method: 'PATCH',
      path: '/apps/live/streams/live%2Fcam-1/tags',
      body: { tags: ['store-downtown'] },
    },
  },
  // ingress
  {
    tool: 'create_ingress',
    args: { app: 'live', inputType: 'rtmp', room: 'demo' },
    expect: {
      method: 'POST',
      path: '/apps/live/ingress',
      body: { inputType: 'rtmp', room: 'demo' },
    },
  },
  {
    tool: 'create_ingress',
    args: {
      app: 'live',
      inputType: 'mpegts',
      mode: 'passthrough',
      url: 'udp://@239.1.1.1:5000',
      sources: '10.0.0.5',
      localaddr: '10.0.0.2',
      fifoSize: 28672,
      overrunNonfatal: true,
    },
    expect: {
      method: 'POST',
      path: '/apps/live/ingress',
      body: {
        inputType: 'mpegts',
        mode: 'passthrough',
        url: 'udp://@239.1.1.1:5000',
        sources: '10.0.0.5',
        localaddr: '10.0.0.2',
        fifoSize: 28672,
        overrunNonfatal: true,
      },
    },
  },
  {
    tool: 'list_ingress',
    args: { app: 'live', room: 'demo', limit: 10 },
    expect: { method: 'GET', path: '/apps/live/ingress', query: { room: 'demo', limit: 10 } },
  },
  {
    tool: 'get_ingress',
    args: { app: 'live', id: 'in_abc' },
    expect: { method: 'GET', path: '/apps/live/ingress/in_abc' },
  },
  {
    tool: 'delete_ingress',
    args: { app: 'live', id: 'in_abc' },
    expect: { method: 'DELETE', path: '/apps/live/ingress/in_abc' },
  },
  // recording
  {
    tool: 'start_recording',
    args: { app: 'live', roomName: 'live-demo', recordMode: 'track' },
    expect: {
      method: 'POST',
      path: '/apps/live/recording/start',
      body: { roomName: 'live-demo', recordMode: 'track' },
    },
  },
  {
    tool: 'stop_recording',
    args: { app: 'live', id: 'EG_x1' },
    expect: { method: 'POST', path: '/apps/live/recording/EG_x1/stop' },
  },
  {
    tool: 'start_stream_recording',
    args: { app: 'live', id: 'live/cam-1', recordMode: 'audio' },
    expect: {
      method: 'POST',
      path: '/apps/live/streams/live%2Fcam-1/record/start',
      body: { recordMode: 'audio' },
    },
  },
  {
    tool: 'stop_stream_recording',
    args: { app: 'live', id: 'live/cam-1' },
    expect: { method: 'POST', path: '/apps/live/streams/live%2Fcam-1/record/stop' },
  },
  // vods
  {
    tool: 'list_vods',
    args: { app: 'live', status: 'ready', order: 'started_at', dir: 'desc' },
    expect: {
      method: 'GET',
      path: '/apps/live/vods',
      query: { status: 'ready', order: 'started_at', dir: 'desc' },
    },
  },
  {
    tool: 'get_vod',
    args: { app: 'live', id: 42 },
    expect: { method: 'GET', path: '/apps/live/vods/42' },
  },
  {
    tool: 'transcribe_vod',
    args: { app: 'live', id: 42 },
    expect: { method: 'POST', path: '/apps/live/vods/42/transcribe' },
  },
  {
    tool: 'get_vod_transcript',
    args: { app: 'live', id: 42 },
    expect: { method: 'GET', path: '/apps/live/vods/42/transcript' },
  },
  {
    tool: 'delete_vod',
    args: { app: 'live', id: 42, confirm: true },
    expect: { method: 'DELETE', path: '/apps/live/vods/42' },
  },
  // plugins
  {
    tool: 'list_plugins',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins' },
  },
  {
    tool: 'get_plugin',
    args: { app: 'live', id: 'yolo' },
    expect: { method: 'GET', path: '/apps/live/plugins/yolo' },
  },
  {
    tool: 'install_plugin',
    args: { app: 'live', id: 'yolo' },
    expect: { method: 'POST', path: '/apps/live/plugins/yolo/install' },
  },
  {
    tool: 'configure_plugin',
    args: { app: 'live', id: 'yolo', enabled: true, config: { threshold: 0.5 } },
    expect: {
      method: 'PATCH',
      path: '/apps/live/plugins/yolo',
      body: { enabled: true, config: { threshold: 0.5 } },
    },
  },
  {
    tool: 'uninstall_plugin',
    args: { app: 'live', id: 'yolo' },
    expect: { method: 'DELETE', path: '/apps/live/plugins/yolo' },
  },
  {
    tool: 'control_plugin_worker',
    args: { app: 'live', id: 'yolo', action: 'start' },
    expect: { method: 'POST', path: '/apps/live/plugins/yolo/worker/start' },
  },
  {
    tool: 'control_plugin_worker',
    args: { app: 'live', id: 'yolo', action: 'stop' },
    expect: { method: 'POST', path: '/apps/live/plugins/yolo/worker/stop' },
  },
  {
    tool: 'control_plugin_worker',
    args: { app: 'live', id: 'yolo', action: 'status' },
    expect: { method: 'GET', path: '/apps/live/plugins/yolo/worker/status' },
  },
  {
    tool: 'get_plugin_logs',
    args: { app: 'live', id: 'yolo', limit: 100 },
    expect: { method: 'GET', path: '/apps/live/plugins/yolo/logs', query: { limit: 100 } },
  },
  // live-control
  {
    tool: 'list_live_control_streams',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/live-control/streams' },
  },
  {
    tool: 'get_live_control_stream',
    args: { app: 'live', streamId: 'live/cam-1' },
    expect: { method: 'GET', path: '/apps/live/plugins/live-control/streams/live%2Fcam-1' },
  },
  {
    tool: 'pause_live_stream',
    args: { app: 'live', streamId: 'live/cam-1', cardTitle: 'Be right back' },
    expect: {
      method: 'POST',
      path: '/apps/live/plugins/live-control/streams/live%2Fcam-1/pause',
      body: { cardTitle: 'Be right back' },
    },
  },
  {
    tool: 'resume_live_stream',
    args: { app: 'live', streamId: 'live/cam-1' },
    expect: { method: 'POST', path: '/apps/live/plugins/live-control/streams/live%2Fcam-1/resume' },
  },
  {
    tool: 'finish_live_stream',
    args: { app: 'live', streamId: 'live/cam-1', assetId: 7 },
    expect: {
      method: 'POST',
      path: '/apps/live/plugins/live-control/streams/live%2Fcam-1/finish',
      body: { assetId: 7 },
    },
  },
  {
    tool: 'list_live_control_assets',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/live-control/assets' },
  },
  {
    tool: 'get_live_control_asset_url',
    args: { app: 'live', id: 7 },
    expect: { method: 'GET', path: '/apps/live/plugins/live-control/assets/7/url' },
  },
  {
    tool: 'delete_live_control_asset',
    args: { app: 'live', id: 7 },
    expect: { method: 'DELETE', path: '/apps/live/plugins/live-control/assets/7' },
  },
  {
    tool: 'get_live_control_settings',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/live-control/settings' },
  },
  {
    tool: 'set_live_control_settings',
    args: { app: 'live', defaultPauseAssetId: 7, defaultFinishAssetId: null },
    expect: {
      method: 'PUT',
      path: '/apps/live/plugins/live-control/settings',
      body: { defaultPauseAssetId: 7, defaultFinishAssetId: null },
    },
  },
  // stream-health
  {
    tool: 'get_stream_health_overview',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/stream-health/overview' },
  },
  {
    tool: 'list_stream_health_events',
    args: { app: 'live', room: 'demo', limit: 20 },
    expect: {
      method: 'GET',
      path: '/apps/live/plugins/stream-health/events',
      query: { room: 'demo', limit: 20 },
    },
  },
  {
    tool: 'get_stream_health_room_settings',
    args: { app: 'live', room: 'demo' },
    expect: { method: 'GET', path: '/apps/live/plugins/stream-health/streams/demo/settings' },
  },
  {
    tool: 'set_stream_health_room_settings',
    args: { app: 'live', room: 'demo', bitrate_drop_pct: 40, stall_sec: 30 },
    expect: {
      method: 'PUT',
      path: '/apps/live/plugins/stream-health/streams/demo/settings',
      body: { config: { bitrate_drop_pct: 40, stall_sec: 30 } },
    },
  },
  // streamflow
  {
    tool: 'list_streamflow_events',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/streamflow/events' },
  },
  {
    tool: 'list_workflows',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/streamflow/workflows' },
  },
  {
    tool: 'get_workflow',
    args: { app: 'live', id: 'wf_1' },
    expect: { method: 'GET', path: '/apps/live/plugins/streamflow/workflows/wf_1' },
  },
  {
    tool: 'create_workflow',
    args: { app: 'live', name: 'Intrusion → notify', enabled: true },
    expect: {
      method: 'POST',
      path: '/apps/live/plugins/streamflow/workflows',
      body: { name: 'Intrusion → notify', enabled: true },
    },
  },
  {
    tool: 'update_workflow',
    args: { app: 'live', id: 'wf_1', enabled: false },
    expect: { method: 'PUT', path: '/apps/live/plugins/streamflow/workflows/wf_1', body: { enabled: false } },
  },
  {
    tool: 'delete_workflow',
    args: { app: 'live', id: 'wf_1' },
    expect: { method: 'DELETE', path: '/apps/live/plugins/streamflow/workflows/wf_1' },
  },
  {
    tool: 'enable_workflow',
    args: { app: 'live', id: 'wf_1', enabled: true },
    expect: {
      method: 'POST',
      path: '/apps/live/plugins/streamflow/workflows/wf_1/enable',
      body: { enabled: true },
    },
  },
  {
    tool: 'run_workflow',
    args: { app: 'live', id: 'wf_1', payload: { foo: 'bar' } },
    expect: {
      method: 'POST',
      path: '/apps/live/plugins/streamflow/workflows/wf_1/run',
      body: { payload: { foo: 'bar' } },
    },
  },
  {
    tool: 'export_workflow',
    args: { app: 'live', id: 'wf_1' },
    expect: { method: 'GET', path: '/apps/live/plugins/streamflow/workflows/wf_1/export' },
  },
  {
    tool: 'import_workflow',
    args: { app: 'live', workflow: { streamflow: 1, name: 'x', graph: {} } },
    expect: {
      method: 'POST',
      path: '/apps/live/plugins/streamflow/workflows/import',
      body: { workflow: { streamflow: 1, name: 'x', graph: {} } },
    },
  },
  {
    tool: 'list_workflow_runs',
    args: { app: 'live', workflowId: 'wf_1', limit: 10 },
    expect: {
      method: 'GET',
      path: '/apps/live/plugins/streamflow/runs',
      query: { workflowId: 'wf_1', limit: 10 },
    },
  },
  {
    tool: 'get_workflow_run',
    args: { app: 'live', id: 'run_1' },
    expect: { method: 'GET', path: '/apps/live/plugins/streamflow/runs/run_1' },
  },
  {
    tool: 'list_streamflow_secrets',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/plugins/streamflow/secrets' },
  },
  {
    tool: 'put_streamflow_secret',
    args: { app: 'live', name: 'OPENAI_API_KEY', value: 'sk-live-x' },
    expect: {
      method: 'PUT',
      path: '/apps/live/plugins/streamflow/secrets/OPENAI_API_KEY',
      body: { value: 'sk-live-x' },
    },
  },
  {
    tool: 'delete_streamflow_secret',
    args: { app: 'live', name: 'OPENAI_API_KEY' },
    expect: { method: 'DELETE', path: '/apps/live/plugins/streamflow/secrets/OPENAI_API_KEY' },
  },
  // tokens
  {
    tool: 'mint_join_token',
    args: { app: 'live', room: 'demo', identity: 'agent', canPublish: false },
    expect: {
      method: 'POST',
      path: '/apps/live/tokens',
      body: { room: 'demo', identity: 'agent', canPublish: false },
    },
  },
  {
    tool: 'sign_playback_url',
    args: { app: 'live', room: 'demo', ttlSeconds: 600 },
    expect: {
      method: 'POST',
      path: '/apps/live/play-token/demo/sign',
      body: { ttlSeconds: 600 },
    },
  },
  { tool: 'list_api_tokens', args: {}, expect: { method: 'GET', path: '/tokens' } },
  {
    tool: 'create_api_token',
    args: { name: 'mcp-agent', scope: 'app', appId: 3 },
    expect: {
      method: 'POST',
      path: '/tokens',
      body: { name: 'mcp-agent', scope: 'app', appId: 3 },
    },
  },
  {
    tool: 'revoke_api_token',
    args: { id: 7 },
    expect: { method: 'DELETE', path: '/tokens/7' },
  },
  // maintenance
  {
    tool: 'get_app_db_health',
    args: { app: 'live' },
    expect: { method: 'GET', path: '/apps/live/db/health' },
  },
  {
    tool: 'purge_app_db',
    args: { app: 'live', scope: 'logs', confirm: true },
    expect: {
      method: 'POST',
      path: '/apps/live/db/purge',
      body: { scope: 'logs', confirm: true },
    },
  },
];

test('mapping table covers every tool in the catalogue', () => {
  const covered = new Set(MAPPING.map((m) => m.tool));
  const missing = TOOLS.map((t) => t.name).filter((n) => !covered.has(n));
  assert.deepEqual(missing, [], `tools without a mapping test: ${missing.join(', ')}`);
});

for (const { tool, args, expect } of MAPPING) {
  const label = 'query' in (args as object) || 'action' in args ? JSON.stringify(args) : '';
  test(`mapping: ${tool} ${args.action ?? ''} → ${expect.method} ${expect.path} ${label}`.trim(), async () => {
    const call = await run(tool, args);
    assert.deepEqual(call, expect);
  });
}

test('handlers strip optional args that were not provided', async () => {
  const call = await run('create_ingress', { app: 'live', inputType: 'whip' });
  assert.deepEqual(call.body, { inputType: 'whip' });
  const token = await run('mint_join_token', { app: 'live' });
  assert.deepEqual(token.body, {});
});
