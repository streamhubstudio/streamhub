/**
 * E2E — the PUBLIC player-overlay endpoint over the REAL AppModule (supertest).
 *
 * Boots the full app with the REAL Bearer guard wired (no AUTH_VALIDATOR bypass),
 * so a request with NO token 401s on protected plugin routes — proving the new
 * `GET /apps/:app/plugins/public` is genuinely @Public. Install state is seeded
 * straight through AppPluginsRepository (bypassing HTTP auth) against the seeded
 * `live` app, then the public route is fetched with no Authorization header.
 *
 * Coverage:
 *   - GET /plugins       401 without a token (guard is really enforcing).
 *   - GET /plugins/public 200 without a token, listing enabled overlays only.
 *   - app-tab plugins + disabled overlays are excluded.
 *   - yolo's callbackUrl is stripped from the public config (no secret leaks).
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { AppPluginsRepository } from '../src/modules/plugins/app-plugins.repository';

const P = '/api/v1';
const APP = 'live';

describe('plugins public overlays (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await bootstrapTestApp();

    // Seed install state directly (no HTTP auth) against the seeded `live` app.
    const repo = ctx.app.get(AppPluginsRepository);
    // Enabled overlay with no secrets → should appear, config intact.
    repo.install(APP, 'timestamp', {}, true);
    // Enabled overlay carrying a callback URL → should appear, URL stripped.
    repo.install(
      APP,
      'yolo',
      {
        room: 'cam1',
        model: 'nano',
        cuda: false,
        callbackUrl: 'https://secret.example.com/hooks/yolo',
        confidence: 0.5,
        fps: 2,
        classes: '',
      },
      true,
    );
    // Enabled app-tab plugin → must NOT appear in the overlay view.
    repo.install(APP, 'cockpit', {}, true);
    // Installed-but-disabled overlay (watermark is ui: 'player-overlay') → must
    // NOT appear, proving the enabled-gate (not just the ui filter).
    repo.install(APP, 'watermark', {}, false);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('401s on the AUTHENTICATED plugins list with no token (guard enforcing)', async () => {
    await ctx.request().get(`${P}/apps/${APP}/plugins`).expect(401);
  });

  it('200s on /plugins/public with NO auth (empty token) and lists overlays only', async () => {
    const res = await ctx.request().get(`${P}/apps/${APP}/plugins/public`).expect(200);
    expect(res.body.error).toBeNull();
    const overlays: Array<{ id: string; manifest: { ui: string } }> = res.body.data;
    const ids = overlays.map((o) => o.id).sort();

    // enabled overlays present; app-tab + disabled overlay absent
    expect(ids).toEqual(['timestamp', 'yolo']);
    expect(ids).not.toContain('cockpit');
    expect(ids).not.toContain('watermark');
    for (const o of overlays) expect(o.manifest.ui).toBe('player-overlay');
  });

  it('strips callback/webhook URLs from the public config (no secret leak)', async () => {
    const res = await ctx.request().get(`${P}/apps/${APP}/plugins/public`).expect(200);
    const yolo = (res.body.data as Array<{ id: string; config: Record<string, unknown> }>).find(
      (o) => o.id === 'yolo',
    );
    expect(yolo).toBeTruthy();
    expect(yolo!.config).not.toHaveProperty('callbackUrl');
    // render-safe fields survive
    expect(yolo!.config.model).toBe('nano');
    // the secret URL appears nowhere in the payload
    expect(JSON.stringify(res.body)).not.toContain('secret.example.com');
  });

  it('exposes the timestamp overlay manifest + render config', async () => {
    const res = await ctx.request().get(`${P}/apps/${APP}/plugins/public`).expect(200);
    const ts = (res.body.data as Array<{ id: string; manifest: Record<string, unknown>; config: Record<string, unknown> }>).find(
      (o) => o.id === 'timestamp',
    );
    expect(ts!.manifest).toMatchObject({ name: 'Timestamp CCTV', ui: 'player-overlay' });
    expect(Array.isArray(ts!.manifest.configSchema)).toBe(true);
    expect(ts!.config).toMatchObject({ format: 'datetime-24h', showName: true });
  });
});
