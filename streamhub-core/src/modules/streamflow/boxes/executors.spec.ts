/**
 * Unit spec — box executors (Streamflow). Each executor runs with a fake `deps`
 * seam (jest fns) + a synthetic bag: no core services, no network. Also covers
 * matchesEventTrigger (event/room/tags/predicate) and normalizeEmitEvent.
 */
import {
  EXECUTORS,
  matchesEventTrigger,
  matchesMqttTrigger,
  normalizeEmitEvent,
  topicMatches,
} from './executors';
import type { BoxContext, BoxDeps, BoxNode } from './context';
import { newBag } from './context';

function ctxFor(
  payload: Record<string, unknown> = {},
  event = 'perimeter.intrusion',
): BoxContext {
  return { app: 'live', appDir: '/tmp/live', trigger: { event, payload }, bag: newBag(event, payload) };
}

function fakeDeps(over: Partial<BoxDeps> = {}): BoxDeps {
  return {
    snapshot: jest.fn(async () => ({ key: 'k', url: 'http://s/k.jpg' })),
    s3Upload: jest.fn(async () => ({ key: 'up', url: 'http://s/up' })),
    ai: jest.fn(async () => ({ text: 'yes', usageTokens: 5, json: { ok: true } })),
    httpPost: jest.fn(async () => ({ ok: true, status: 200, body: { ok: 1 } })),
    emit: jest.fn(async () => undefined),
    mqttPublish: jest.fn(async () => undefined),
    notify: jest.fn(async () => undefined),
    pluginEvent: jest.fn(async () => ({ ok: true, status: 202 })),
    sleep: jest.fn(async () => undefined),
    now: () => 1000,
    log: jest.fn(),
    ...over,
  };
}

const run = (type: string, config: Record<string, unknown>, ctx: BoxContext, deps: BoxDeps) => {
  const box: BoxNode = { id: 'x', type, config };
  return EXECUTORS[type](box, ctx, deps);
};

describe('trigger executors', () => {
  it('emit the trigger payload as output', async () => {
    const ctx = ctxFor({ room: 'gate' });
    const out = await run('trigger.event', {}, ctx, fakeDeps());
    expect(out.output).toEqual({ room: 'gate' });
    expect(out.port).toBe('out');
  });
});

describe('action.snapshot', () => {
  it('snapshots the trigger room by default', async () => {
    const deps = fakeDeps();
    const ctx = ctxFor({ room: 'gate' });
    const out = await run('action.snapshot', {}, ctx, deps);
    expect(deps.snapshot).toHaveBeenCalledWith({ app: 'live', room: 'gate', participantIdentity: undefined });
    expect(out.output).toEqual({ key: 'k', url: 'http://s/k.jpg' });
  });
  it('throws when no room is available', async () => {
    await expect(run('action.snapshot', {}, ctxFor({}), fakeDeps())).rejects.toThrow(/no room/);
  });
});

describe('action.s3', () => {
  it('uploads a JSON blob by default', async () => {
    const deps = fakeDeps();
    const ctx = ctxFor({ room: 'gate' });
    ctx.bag.snap = { url: 'http://s/x.jpg' };
    const out = await run('action.s3', { key: 'out.json', content: '{{snap}}' }, ctx, deps);
    const call = (deps.s3Upload as jest.Mock).mock.calls[0][0];
    expect(call.key).toBe('out.json');
    expect(Buffer.isBuffer(call.body)).toBe(true);
    expect(out.output).toEqual({ key: 'up', url: 'http://s/up' });
  });
  it('decodes base64 content when flagged', async () => {
    const deps = fakeDeps();
    await run('action.s3', { key: 'a.bin', content: 'QUJD', base64: true }, ctxFor(), deps);
    const call = (deps.s3Upload as jest.Mock).mock.calls[0][0];
    expect((call.body as Buffer).toString('utf8')).toBe('ABC');
  });
});

describe('action.http', () => {
  it('posts the mapped body and reports out on 2xx', async () => {
    const deps = fakeDeps();
    const ctx = ctxFor({ plate: 'ABC' });
    const out = await run('action.http', { url: 'https://hook/x', body: { p: '{{trigger.plate}}' } }, ctx, deps);
    expect(deps.httpPost).toHaveBeenCalledWith({ url: 'https://hook/x', body: { p: 'ABC' }, headers: {} });
    expect(out.port).toBe('out');
  });
  it('routes to the error port on non-2xx', async () => {
    const deps = fakeDeps({ httpPost: jest.fn(async () => ({ ok: false, status: 500, body: null })) });
    const out = await run('action.http', { url: 'https://hook/x' }, ctxFor(), deps);
    expect(out.port).toBe('error');
  });
  it('throws when url is missing', async () => {
    await expect(run('action.http', {}, ctxFor(), fakeDeps())).rejects.toThrow(/url/);
  });
});

describe('action.ai', () => {
  it('sends the prompt + templated image url', async () => {
    const deps = fakeDeps();
    const ctx = ctxFor({ room: 'gate' });
    ctx.bag.snap = { url: 'http://s/frame.jpg' };
    await run('action.ai', { prompt: 'real intrusion?', imageUrl: '{{snap.url}}', jsonMode: true }, ctx, deps);
    const arg = (deps.ai as jest.Mock).mock.calls[0][0];
    expect(arg).toMatchObject({ app: 'live', prompt: 'real intrusion?', imageUrl: 'http://s/frame.jpg', jsonMode: true });
  });
  it('throws with no prompt', async () => {
    await expect(run('action.ai', {}, ctxFor(), fakeDeps())).rejects.toThrow(/prompt/);
  });
});

describe('action.emit', () => {
  it('normalizes the event name and dispatches', async () => {
    const deps = fakeDeps();
    await run('action.emit', { event: 'not.allowed', payload: { a: 1 } }, ctxFor(), deps);
    expect(deps.emit).toHaveBeenCalledWith({ app: 'live', event: 'streamflow.output', payload: { a: 1 } });
  });
});

describe('action.mqtt', () => {
  it('publishes the mapped payload to the topic', async () => {
    const deps = fakeDeps();
    const ctx = ctxFor({ plate: 'ABC' });
    const out = await run(
      'action.mqtt',
      { topic: 'gate/plate', payload: { p: '{{trigger.plate}}' }, qos: 1, retain: true },
      ctx,
      deps,
    );
    expect(deps.mqttPublish).toHaveBeenCalledWith({
      app: 'live',
      topic: 'gate/plate',
      payload: { p: 'ABC' },
      qos: 1,
      retain: true,
    });
    expect(out.port).toBe('out');
  });
  it('defaults payload to the trigger and throws without a topic', async () => {
    const deps = fakeDeps();
    await run('action.mqtt', { topic: 'x' }, ctxFor({ a: 1 }), deps);
    expect((deps.mqttPublish as jest.Mock).mock.calls[0][0].payload).toEqual({ a: 1 });
    await expect(run('action.mqtt', {}, ctxFor(), fakeDeps())).rejects.toThrow(/topic/);
  });
});

describe('matchesMqttTrigger + topicMatches', () => {
  it('matches iot.data topics against MQTT-style filters', () => {
    expect(matchesMqttTrigger({ topic: 'sensors/+/temp' }, { topic: 'sensors/a/temp' })).toBe(true);
    expect(matchesMqttTrigger({ topic: 'sensors/#' }, { topic: 'sensors/a/b/c' })).toBe(true);
    expect(matchesMqttTrigger({ topic: 'sensors/+/temp' }, { topic: 'sensors/a/hum' })).toBe(false);
    expect(matchesMqttTrigger({ topic: '' }, { topic: 'anything' })).toBe(true);
    expect(matchesMqttTrigger({ topic: 'a/b' }, {})).toBe(false);
  });
  it('topicMatches handles +, #, * and exact', () => {
    expect(topicMatches('a/b', 'a/b')).toBe(true);
    expect(topicMatches('a/+', 'a/b')).toBe(true);
    expect(topicMatches('a/+', 'a/b/c')).toBe(false);
    expect(topicMatches('a/#', 'a/b/c')).toBe(true);
    expect(topicMatches('*', 'a/b')).toBe(true);
    expect(topicMatches('a/b', 'a/c')).toBe(false);
  });
});

describe('action.notify', () => {
  it('fans out with title + channels', async () => {
    const deps = fakeDeps();
    await run('action.notify', { title: 'Intrusion!', channels: ['discord'] }, ctxFor({ room: 'gate' }), deps);
    const arg = (deps.notify as jest.Mock).mock.calls[0][0];
    expect(arg).toMatchObject({ app: 'live', title: 'Intrusion!', channels: ['discord'] });
  });
});

describe('action.plugin', () => {
  it('posts to the target plugin event channel', async () => {
    const deps = fakeDeps();
    const out = await run(
      'action.plugin',
      { plugin: 'lpr', event: 'plate.detected', data: { plate: '{{trigger.plate}}' }, token: 't' },
      ctxFor({ plate: 'XYZ', room: 'gate' }),
      deps,
    );
    expect(deps.pluginEvent).toHaveBeenCalledWith(
      expect.objectContaining({ app: 'live', pluginId: 'lpr', event: 'plate.detected', data: { plate: 'XYZ' }, token: 't' }),
    );
    expect(out.port).toBe('out');
  });
  it('throws without plugin/event', async () => {
    await expect(run('action.plugin', { plugin: 'lpr' }, ctxFor(), fakeDeps())).rejects.toThrow();
  });
});

describe('logic.condition', () => {
  it('selects the true/false port', async () => {
    const ctx = ctxFor({ conf: 0.9 });
    const t = await run('logic.condition', { rules: [{ field: 'trigger.conf', op: 'gt', value: 0.7 }] }, ctx, fakeDeps());
    expect(t.port).toBe('true');
    const f = await run('logic.condition', { rules: [{ field: 'trigger.conf', op: 'gt', value: 0.99 }] }, ctx, fakeDeps());
    expect(f.port).toBe('false');
  });
});

describe('logic.delay', () => {
  it('sleeps the bounded duration', async () => {
    const deps = fakeDeps();
    await run('logic.delay', { seconds: 2 }, ctxFor(), deps);
    expect(deps.sleep).toHaveBeenCalledWith(2000);
  });
  it('caps at 60s', async () => {
    const deps = fakeDeps();
    await run('logic.delay', { seconds: 9999 }, ctxFor(), deps);
    expect(deps.sleep).toHaveBeenCalledWith(60000);
  });
});

describe('logic.setvar', () => {
  it('writes resolved vars into the bag', async () => {
    const ctx = ctxFor({ plate: 'ABC' });
    await run('logic.setvar', { set: { 'vars.plate': '{{trigger.plate}}' } }, ctx, fakeDeps());
    expect((ctx.bag.vars as Record<string, unknown>).plate).toBe('ABC');
  });
});

describe('logic.switch', () => {
  it('routes by field value', async () => {
    const ctx = ctxFor({ type: 'truck' });
    const out = await run(
      'logic.switch',
      { field: 'trigger.type', cases: [{ value: 'car', port: 'cars' }, { value: 'truck', port: 'trucks' }] },
      ctx,
      fakeDeps(),
    );
    expect(out.port).toBe('trucks');
  });
});

describe('dangerous execution boxes (flag-gated)', () => {
  const dangerDeps = () =>
    fakeDeps({
      runCode: jest.fn(async () => ({ ok: true, output: 42 })),
      runShell: jest.fn(async () => ({ ok: true, code: 0, stdout: 'hi', stderr: '' })),
      runSsh: jest.fn(async () => ({ ok: true, code: 0, stdout: 'ok', stderr: '' })),
      runDb: jest.fn(async () => ({ ok: true, output: [{ id: 1 }], rowCount: 1 })),
    });

  const enabledCtx = (payload: Record<string, unknown> = {}) => {
    const c = ctxFor(payload);
    c.dangerousEnabled = true;
    return c;
  };

  it('ALL refuse when dangerousEnabled is falsy', async () => {
    const deps = dangerDeps();
    for (const type of ['action.code', 'action.shell', 'action.ssh', 'action.db']) {
      await expect(run(type, { source: 'x', command: 'x', host: 'h', user: 'u', dsn: 'd', query: 'q' }, ctxFor(), deps)).rejects.toThrow(/disabled/);
    }
  });

  it('action.code calls the sandbox and routes out/error', async () => {
    const deps = dangerDeps();
    const out = await run('action.code', { source: 'output = 42' }, enabledCtx(), deps);
    expect((deps.runCode as jest.Mock)).toHaveBeenCalled();
    expect(out.port).toBe('out');
    const failDeps = fakeDeps({ runCode: jest.fn(async () => ({ ok: false, error: 'boom' })) });
    const c = enabledCtx();
    const fail = await run('action.code', { source: 'x' }, c, failDeps);
    expect(fail.port).toBe('error');
  });

  it('action.shell passes an argv array, never a shell string', async () => {
    const deps = dangerDeps();
    await run('action.shell', { command: 'ls', args: ['-la', '{{trigger.dir}}'] }, enabledCtx({ dir: '/tmp' }), deps);
    const arg = (deps.runShell as jest.Mock).mock.calls[0][0];
    expect(arg.command).toBe('ls');
    expect(arg.args).toEqual(['-la', '/tmp']);
  });

  it('action.ssh forwards the resolved key + command (no inline key)', async () => {
    const deps = dangerDeps();
    // The runner resolves {{secret.NAME}} before the executor; here config.key is
    // already the resolved plaintext.
    await run('action.ssh', { host: 'h', user: 'u', key: 'PRIVATE-KEY', command: 'uptime' }, enabledCtx(), deps);
    const arg = (deps.runSsh as jest.Mock).mock.calls[0][0];
    expect(arg).toMatchObject({ host: 'h', user: 'u', privateKey: 'PRIVATE-KEY', command: 'uptime' });
  });

  it('action.db uses PARAMETERIZED queries — params array is separate from the SQL text', async () => {
    const deps = dangerDeps();
    await run(
      'action.db',
      { engine: 'postgres', dsn: 'postgres://x', query: 'SELECT * FROM t WHERE id = $1', params: ['{{trigger.id}}'] },
      enabledCtx({ id: 7 }),
      deps,
    );
    const arg = (deps.runDb as jest.Mock).mock.calls[0][0];
    expect(arg.query).toBe('SELECT * FROM t WHERE id = $1'); // SQL text verbatim
    expect(arg.params).toEqual([7]); // params bound separately, resolved from the bag
    expect(arg.engine).toBe('postgres');
  });
});

describe('matchesEventTrigger', () => {
  it('matches by exact event and prefix wildcard', () => {
    expect(matchesEventTrigger({ event: 'perimeter.intrusion' }, 'perimeter.intrusion', {})).toBe(true);
    expect(matchesEventTrigger({ event: 'plate.*' }, 'plate.detected', {})).toBe(true);
    expect(matchesEventTrigger({ event: 'plate.*' }, 'occupancy.in', {})).toBe(false);
    expect(matchesEventTrigger({}, 'anything', {})).toBe(true);
  });
  it('filters by room, tags and predicate', () => {
    expect(matchesEventTrigger({ event: 'e', room: 'gate' }, 'e', { room: 'gate' })).toBe(true);
    expect(matchesEventTrigger({ event: 'e', room: 'gate' }, 'e', { room: 'door' })).toBe(false);
    expect(matchesEventTrigger({ event: 'e', tags: ['vip'] }, 'e', { tags: ['vip', 'x'] })).toBe(true);
    expect(matchesEventTrigger({ event: 'e', tags: ['vip'] }, 'e', { tags: ['x'] })).toBe(false);
    expect(
      matchesEventTrigger(
        { event: 'e', predicate: { rules: [{ field: 'trigger.conf', op: 'gt', value: 0.7 }] } },
        'e',
        { conf: 0.9 },
      ),
    ).toBe(true);
    expect(
      matchesEventTrigger(
        { event: 'e', predicate: { rules: [{ field: 'trigger.conf', op: 'gt', value: 0.95 }] } },
        'e',
        { conf: 0.9 },
      ),
    ).toBe(false);
  });
});

describe('normalizeEmitEvent', () => {
  it('coerces unknown names to streamflow.output', () => {
    expect(normalizeEmitEvent('streamflow.run_finished')).toBe('streamflow.run_finished');
    expect(normalizeEmitEvent('evil.event')).toBe('streamflow.output');
    expect(normalizeEmitEvent(undefined)).toBe('streamflow.output');
  });
});
