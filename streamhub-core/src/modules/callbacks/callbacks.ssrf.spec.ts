/**
 * Unit spec — CallbacksService fire-time SSRF guard (fix P0-1).
 *
 * The callback URL is TENANT-controlled: without the guard the core would
 * POST signed payloads at any address a tenant chose (cloud metadata,
 * internal services). Locks down the fire-time deny path:
 *   - a metadata-IP callback URL is dropped (fetch NEVER called),
 *   - a hostname resolving to RFC1918 is dropped (injected DNS fake),
 *   - a public target still fires,
 *   - STREAMHUB_CALLBACK_ALLOW_HOSTS (default empty) is the ONLY way a
 *     private target fires, and it never throws either way.
 *
 * global.fetch is stubbed and DNS is a fake resolver — nothing dials out.
 */
import { CallbacksService } from './callbacks.service';
import { CALLBACK_ALLOW_HOSTS_ENV } from '../security/egress-url.guard';
import { mockAppsService, mockLogsService } from '../../../test/helpers';

function configWith(url: string): never {
  return { callbacks: { url, secret: 's3cr3t' } } as never;
}

describe('CallbacksService — egress SSRF guard (fire-time)', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let svc: CallbacksService;
  let realFetch: typeof global.fetch;
  const prevAllow = process.env[CALLBACK_ALLOW_HOSTS_ENV];

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    svc = new CallbacksService(apps as never, logs as never);
    // DNS fake: evil hosts resolve private, good hosts resolve public.
    svc.hostResolver = async (hostname: string) => {
      if (hostname === 'intranet.evil.tld') return ['10.20.30.40'];
      if (hostname === 'hooks.internal.lan') return ['192.168.7.7'];
      if (hostname === 'hook.example.com') return ['93.184.216.34'];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }) as never);
    delete process.env[CALLBACK_ALLOW_HOSTS_ENV];
  });

  afterEach(() => {
    global.fetch = realFetch;
    if (prevAllow === undefined) delete process.env[CALLBACK_ALLOW_HOSTS_ENV];
    else process.env[CALLBACK_ALLOW_HOSTS_ENV] = prevAllow;
  });

  it('DROPS a callback aimed at the cloud metadata endpoint (IP literal)', async () => {
    apps.getConfig.mockResolvedValue(
      configWith('http://169.254.169.254/latest/meta-data/'),
    );
    await svc.dispatch('live', 'stream_started', { room: 'live-1' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(logs.write).toHaveBeenCalledWith(
      'error',
      'callbacks',
      expect.stringContaining('SSRF'),
      expect.objectContaining({ url: expect.any(String) }),
    );
  });

  it('DROPS a callback whose hostname RESOLVES to an RFC1918 address', async () => {
    apps.getConfig.mockResolvedValue(configWith('https://intranet.evil.tld/hook'));
    await svc.dispatch('live', 'vod_ready', { room: 'live-1' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:3020/api/v1/health',
    'http://[::1]:6379/',
    'http://0.0.0.0:8080/x',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_SET%20x%20y',
  ])('DROPS %s (loopback / unspecified / forbidden scheme)', async (url) => {
    apps.getConfig.mockResolvedValue(configWith(url));
    await svc.dispatch('live', 'stream_ended', { room: 'live-1' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still FIRES a public callback target', async () => {
    apps.getConfig.mockResolvedValue(configWith('https://hook.example.com/cb'));
    await svc.dispatch('live', 'stream_started', { room: 'live-1' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('the env allowlist (default empty) admits a named internal host', async () => {
    process.env[CALLBACK_ALLOW_HOSTS_ENV] = 'hooks.internal.lan';
    apps.getConfig.mockResolvedValue(configWith('https://hooks.internal.lan/cb'));
    await svc.dispatch('live', 'stream_started', { room: 'live-1' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('the allowlist does NOT open unrelated private targets', async () => {
    process.env[CALLBACK_ALLOW_HOSTS_ENV] = 'hooks.internal.lan';
    apps.getConfig.mockResolvedValue(configWith('https://intranet.evil.tld/hook'));
    await svc.dispatch('live', 'stream_started', { room: 'live-1' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never throws on a blocked callback (best-effort contract)', async () => {
    apps.getConfig.mockResolvedValue(configWith('http://10.0.0.1/hook'));
    await expect(
      svc.dispatch('live', 'recording_failed', { room: 'live-1' }),
    ).resolves.toBeUndefined();
  });
});
