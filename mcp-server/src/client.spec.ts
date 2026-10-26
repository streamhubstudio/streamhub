/**
 * StreamHubClient specs: envelope unwrapping, error surfacing, URL/query
 * building and headers — all against a mocked fetch, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defined,
  extractErrorMessage,
  StreamHubApiError,
  StreamHubClient,
  unwrapEnvelope,
} from './client.ts';

const CFG = { baseUrl: 'https://media.example.com/api/v1', token: 'sk_test_123' };

interface Captured {
  url: string;
  init: RequestInit;
}

/** fetch stub that records the call and answers with a canned response. */
function fetchStub(
  status: number,
  body: unknown,
  captured: Captured[] = [],
): { fetchImpl: typeof fetch; captured: Captured[] } {
  const fetchImpl = (async (input: any, init?: any) => {
    captured.push({ url: String(input), init: init ?? {} });
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status });
  }) as typeof fetch;
  return { fetchImpl, captured };
}

test('request: sends bearer auth + accept header, builds the URL from baseUrl', async () => {
  const { fetchImpl, captured } = fetchStub(200, { data: [], error: null });
  const client = new StreamHubClient(CFG, fetchImpl);
  await client.get('/apps');

  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, 'https://media.example.com/api/v1/apps');
  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk_test_123');
  assert.equal(headers.accept, 'application/json');
  assert.equal(captured[0]!.init.method, 'GET');
});

test('request: JSON body gets content-type and is serialized once', async () => {
  const { fetchImpl, captured } = fetchStub(201, { data: { id: 1 }, error: null });
  const client = new StreamHubClient(CFG, fetchImpl);
  await client.post('/apps', { name: 'live' });

  const headers = captured[0]!.init.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(captured[0]!.init.body, '{"name":"live"}');
});

test('request: query params are serialized, undefined/null skipped', async () => {
  const { fetchImpl, captured } = fetchStub(200, { data: [], error: null });
  const client = new StreamHubClient(CFG, fetchImpl);
  await client.get('/logs', {
    query: { level: 'error', limit: 50, q: undefined, app: null, ok: true },
  });

  const url = new URL(captured[0]!.url);
  assert.equal(url.pathname, '/api/v1/logs');
  assert.equal(url.searchParams.get('level'), 'error');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('ok'), 'true');
  assert.equal(url.searchParams.has('q'), false);
  assert.equal(url.searchParams.has('app'), false);
});

test('request: unwraps the { data, error: null } envelope', async () => {
  const { fetchImpl } = fetchStub(200, { data: { name: 'live', id: 3 }, error: null });
  const client = new StreamHubClient(CFG, fetchImpl);
  assert.deepEqual(await client.get('/apps/live'), { name: 'live', id: 3 });
});

test('request: paginated envelope becomes { items, total, limit, offset }', async () => {
  const { fetchImpl } = fetchStub(200, {
    data: [{ id: 'in_1' }],
    total: 128,
    limit: 50,
    offset: 0,
  });
  const client = new StreamHubClient(CFG, fetchImpl);
  assert.deepEqual(await client.get('/apps/live/ingress'), {
    items: [{ id: 'in_1' }],
    total: 128,
    limit: 50,
    offset: 0,
  });
});

test('request: non-envelope bodies pass through untouched', async () => {
  const { fetchImpl } = fetchStub(200, { status: 'ok', uptime: 42 });
  const client = new StreamHubClient(CFG, fetchImpl);
  assert.deepEqual(await client.get('/health'), { status: 'ok', uptime: 42 });
});

test('request: 204 No Content becomes { ok: true }', async () => {
  const { fetchImpl } = fetchStub(204, undefined);
  const client = new StreamHubClient(CFG, fetchImpl);
  assert.deepEqual(await client.del('/apps/live/streams/s1'), { ok: true });
});

test('request: non-2xx throws StreamHubApiError with the Nest message', async () => {
  const { fetchImpl } = fetchStub(404, {
    statusCode: 404,
    message: 'App not found',
    error: 'Not Found',
  });
  const client = new StreamHubClient(CFG, fetchImpl);
  await assert.rejects(client.get('/apps/nope'), (err: unknown) => {
    assert.ok(err instanceof StreamHubApiError);
    assert.equal(err.status, 404);
    assert.equal(err.message, 'App not found');
    return true;
  });
});

test('request: validation errors (message array) are joined', async () => {
  const { fetchImpl } = fetchStub(400, {
    statusCode: 400,
    message: ['name must be a string', 'scope must be one of global, app'],
    error: 'Bad Request',
  });
  const client = new StreamHubClient(CFG, fetchImpl);
  await assert.rejects(client.post('/tokens', {}), (err: unknown) => {
    assert.ok(err instanceof StreamHubApiError);
    assert.equal(err.status, 400);
    assert.equal(err.message, 'name must be a string; scope must be one of global, app');
    return true;
  });
});

test('request: network failure surfaces as StreamHubApiError status 0', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const client = new StreamHubClient(CFG, fetchImpl);
  await assert.rejects(client.get('/health'), (err: unknown) => {
    assert.ok(err instanceof StreamHubApiError);
    assert.equal(err.status, 0);
    assert.match(err.message, /Cannot reach StreamHub/);
    return true;
  });
});

test('unwrapEnvelope: envelope with a non-null error throws', () => {
  assert.throws(
    () => unwrapEnvelope({ data: null, error: 'quota exceeded' }, 200),
    (err: unknown) => err instanceof StreamHubApiError && /quota exceeded/.test(err.message),
  );
});

test('unwrapEnvelope: arrays and scalars pass through', () => {
  assert.deepEqual(unwrapEnvelope([1, 2]), [1, 2]);
  assert.equal(unwrapEnvelope('ok'), 'ok');
  assert.equal(unwrapEnvelope(null), null);
});

test('extractErrorMessage: fallbacks', () => {
  assert.equal(extractErrorMessage({ error: 'Forbidden' }, 403), 'Forbidden');
  assert.equal(extractErrorMessage('plain text body', 500), 'plain text body');
  assert.equal(extractErrorMessage(null, 502), 'HTTP 502');
});

test('defined: strips undefined but keeps false/0/null/empty-string', () => {
  assert.deepEqual(defined({ a: undefined, b: false, c: 0, d: null, e: '' }), {
    b: false,
    c: 0,
    d: null,
    e: '',
  });
});

test('origin: strips the /api/v1 suffix', () => {
  const client = new StreamHubClient(CFG, fetchStub(200, {}).fetchImpl);
  assert.equal(client.origin, 'https://media.example.com');
});
