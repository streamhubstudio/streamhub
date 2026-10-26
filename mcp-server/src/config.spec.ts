import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, normalizeBaseUrl } from './config.ts';

const ENV = {
  STREAMHUB_API_URL: 'https://media.example.com',
  STREAMHUB_API_TOKEN: 'sk_test_123',
};

test('normalizeBaseUrl: appends /api/v1 to a bare origin', () => {
  assert.equal(normalizeBaseUrl('https://media.example.com'), 'https://media.example.com/api/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3020'), 'http://127.0.0.1:3020/api/v1');
});

test('normalizeBaseUrl: strips trailing slashes, keeps an existing /api/v1', () => {
  assert.equal(normalizeBaseUrl('https://media.example.com/'), 'https://media.example.com/api/v1');
  assert.equal(
    normalizeBaseUrl('https://media.example.com/api/v1'),
    'https://media.example.com/api/v1',
  );
  assert.equal(
    normalizeBaseUrl('https://media.example.com/api/v1/'),
    'https://media.example.com/api/v1',
  );
});

test('loadConfig: happy path, destructive off by default', () => {
  const cfg = loadConfig(ENV, ['node', 'index.js']);
  assert.equal(cfg.baseUrl, 'https://media.example.com/api/v1');
  assert.equal(cfg.token, 'sk_test_123');
  assert.equal(cfg.allowDestructive, false);
});

test('loadConfig: missing URL or token throws a clear error', () => {
  assert.throws(() => loadConfig({ STREAMHUB_API_TOKEN: 'sk_x' }, []), /STREAMHUB_API_URL/);
  assert.throws(
    () => loadConfig({ STREAMHUB_API_URL: 'http://127.0.0.1:3020' }, []),
    /STREAMHUB_API_TOKEN/,
  );
});

test('loadConfig: --allow-destructive flag enables destructive tools', () => {
  const cfg = loadConfig(ENV, ['node', 'index.js', '--allow-destructive']);
  assert.equal(cfg.allowDestructive, true);
});

test('loadConfig: STREAMHUB_ALLOW_DESTRUCTIVE env var (truthy variants only)', () => {
  for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
    assert.equal(
      loadConfig({ ...ENV, STREAMHUB_ALLOW_DESTRUCTIVE: v }, []).allowDestructive,
      true,
      `expected "${v}" to enable`,
    );
  }
  for (const v of ['false', '0', 'off', '', 'nope']) {
    assert.equal(
      loadConfig({ ...ENV, STREAMHUB_ALLOW_DESTRUCTIVE: v }, []).allowDestructive,
      false,
      `expected "${v}" to stay disabled`,
    );
  }
});
