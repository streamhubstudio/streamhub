/**
 * E2E spec — config-samples-apps module over the FULL AppModule (supertest).
 *
 * Boots the real app via the harness `bootstrapTestApp` (temp DATA_DIR, seeded
 * `live` app + samples, BullMQ/Redis mocked). The global Bearer guard is
 * satisfied by overriding AUTH_VALIDATOR with a bypass so we exercise the HTTP
 * contract (routing, DTO validation, envelopes, status codes) rather than auth.
 * Permission checks run in `log` mode (harness env) so RBAC never blocks.
 *
 * Coverage:
 *   - apps CRUD: POST/GET/PATCH/DELETE + slug (400) and duplicate (409) edges.
 *   - config: raw GET/PUT (+400 on bad YAML), dry-run validate, backups list/
 *     read, revert, reload.
 *   - s3: masked GET/PUT + fold-3 public_url confirmation gate.
 *   - samples: list/get/put/regenerate per app + isolation + 400 on bad name.
 *
 * Owned by the config-samples-apps test agent. Touches only this *.e2e-spec.ts.
 */
import { bootstrapTestApp, type TestApp } from './helpers';
import { AUTH_VALIDATOR } from '../src/shared/auth';

const P = '/api/v1';

/** Bypass the Bearer guard: always resolve a global auth context. */
const bypassAuth = {
  validate: async () => ({ tokenId: 0, scope: 'global' as const, appId: null }),
};

describe('config-samples-apps (e2e)', () => {
  let ctx: TestApp;
  const api = () => ctx.request();

  beforeAll(async () => {
    ctx = await bootstrapTestApp({
      overrides: (b) =>
        b.overrideProvider(AUTH_VALIDATOR).useValue(bypassAuth),
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // apps CRUD
  // ===========================================================================
  describe('apps CRUD', () => {
    it('GET /apps lists apps (seeded "live" present)', async () => {
      const res = await api().get(`${P}/apps`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((a: { name: string }) => a.name === 'live')).toBe(true);
    });

    it('POST /apps creates an app (201) with the given slug', async () => {
      const res = await api()
        .post(`${P}/apps`)
        .send({ name: 'e2e-create', displayName: 'E2E Create' })
        .expect(201);
      expect(res.body).toMatchObject({
        name: 'e2e-create',
        displayName: 'E2E Create',
        livekitRoomPrefix: 'e2e-create',
      });
    });

    it('POST /apps rejects an invalid slug with 400 (DTO)', async () => {
      await api().post(`${P}/apps`).send({ name: 'Bad Name!' }).expect(400);
    });

    it('POST /apps rejects a duplicate name with 409', async () => {
      await api().post(`${P}/apps`).send({ name: 'e2e-dup' }).expect(201);
      await api().post(`${P}/apps`).send({ name: 'e2e-dup' }).expect(409);
    });

    it('GET /apps/:name returns the app; 404 for a missing one', async () => {
      await api().post(`${P}/apps`).send({ name: 'e2e-get' }).expect(201);
      const res = await api().get(`${P}/apps/e2e-get`).expect(200);
      expect(res.body.name).toBe('e2e-get');
      await api().get(`${P}/apps/does-not-exist`).expect(404);
    });

    it('PATCH /apps/:name edits config and returns the merged resolved config', async () => {
      await api().post(`${P}/apps`).send({ name: 'e2e-patch' }).expect(201);
      const res = await api()
        .patch(`${P}/apps/e2e-patch`)
        .send({ displayName: 'Patched', recordingEnabled: false })
        .expect(200);
      expect(res.body.displayName).toBe('Patched');
      expect(res.body.recording.enabled).toBe(false);
    });

    it('DELETE /apps/:name removes the app (and 404 afterwards)', async () => {
      await api().post(`${P}/apps`).send({ name: 'e2e-del' }).expect(201);
      const res = await api().delete(`${P}/apps/e2e-del`).expect(200);
      expect(res.body).toMatchObject({ deleted: true, name: 'e2e-del' });
      await api().get(`${P}/apps/e2e-del`).expect(404);
    });

    it('DELETE /apps/:name is 404 for a missing app', async () => {
      await api().delete(`${P}/apps/never-existed`).expect(404);
    });
  });

  // ===========================================================================
  // config — raw GET/PUT + dry-run + backups + revert + reload
  // ===========================================================================
  describe('config editor', () => {
    const app = 'e2e-config';

    beforeAll(async () => {
      await api().post(`${P}/apps`).send({ name: app }).expect(201);
    });

    it('GET /config/raw returns the enveloped YAML text', async () => {
      const res = await api().get(`${P}/apps/${app}/config/raw`).expect(200);
      expect(res.body.error).toBeNull();
      expect(res.body.data.yaml).toContain(`name: ${app}`);
    });

    it('PUT /config/raw writes valid YAML and hot-reloads', async () => {
      const yaml = `name: ${app}\ndisplay_name: E2E Cfg\nroom_prefix: ${app}\nrecording:\n  enabled: false\n`;
      const res = await api()
        .put(`${P}/apps/${app}/config/raw`)
        .send({ yaml })
        .expect(200);
      expect(res.body.data.reloaded).toBe(true);
      // Read-back reflects the write.
      const back = await api().get(`${P}/apps/${app}/config/raw`).expect(200);
      expect(back.body.data.yaml).toBe(yaml);
    });

    it('PUT /config/raw rejects unparseable YAML with 400 (no write)', async () => {
      const before = (
        await api().get(`${P}/apps/${app}/config/raw`).expect(200)
      ).body.data.yaml;
      await api()
        .put(`${P}/apps/${app}/config/raw`)
        .send({ yaml: 'foo: [unclosed' })
        .expect(400);
      const after = (
        await api().get(`${P}/apps/${app}/config/raw`).expect(200)
      ).body.data.yaml;
      expect(after).toBe(before);
    });

    it('POST /config/raw/validate dry-runs (valid + diff, no write)', async () => {
      const proposed = `name: ${app}\ndisplay_name: Proposed\nroom_prefix: ${app}\n`;
      const res = await api()
        .post(`${P}/apps/${app}/config/raw/validate`)
        .send({ yaml: proposed })
        .expect(201);
      expect(res.body.data).toMatchObject({ valid: true, changed: true });
      expect(res.body.data.diff).toMatch(/^[+-] /m);
    });

    it('POST /config/raw/validate reports valid=false without 500 on bad config', async () => {
      const res = await api()
        .post(`${P}/apps/${app}/config/raw/validate`)
        .send({ yaml: 'just a scalar' })
        .expect(201);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.error).toBeTruthy();
    });

    it('GET /config/backups lists backups; GET/:ts reads one; revert restores it', async () => {
      // The earlier PUT created at least one backup of the previous config.
      const list = await api().get(`${P}/apps/${app}/config/backups`).expect(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data.length).toBeGreaterThanOrEqual(1);

      const ts = list.body.data[0].ts as string;
      const one = await api()
        .get(`${P}/apps/${app}/config/backups/${ts}`)
        .expect(200);
      expect(typeof one.body.data.yaml).toBe('string');

      const revert = await api()
        .post(`${P}/apps/${app}/config/backups/${ts}/revert`)
        .expect(201);
      expect(revert.body.data.reloaded).toBe(true);
      // Live config now equals the reverted backup.
      const live = await api().get(`${P}/apps/${app}/config/raw`).expect(200);
      expect(live.body.data.yaml).toBe(one.body.data.yaml);
    });

    it('GET /config/backups/:ts is 404 for an unknown id', async () => {
      await api()
        .get(`${P}/apps/${app}/config/backups/20990101T000000000Z`)
        .expect(404);
    });

    it('POST /reload hot-reloads the app', async () => {
      const res = await api().post(`${P}/apps/${app}/reload`).expect(201);
      expect(res.body.data.reloaded).toBe(true);
    });
  });

  // ===========================================================================
  // s3 — masked getter/setter
  // ===========================================================================
  describe('s3 config', () => {
    const app = 'e2e-s3';

    beforeAll(async () => {
      await api().post(`${P}/apps`).send({ name: app }).expect(201);
    });

    it('GET /s3 returns a masked, not-configured view', async () => {
      const res = await api().get(`${P}/apps/${app}/s3`).expect(200);
      expect(res.body.data).toMatchObject({
        configured: false,
        hasKey: false,
        publicVods: false,
      });
    });

    it('PUT /s3 persists non-secret fields + masks credentials', async () => {
      const res = await api()
        .put(`${P}/apps/${app}/s3`)
        .send({ bucket: 'e2e-bucket', key: 'AKIA_E2E', secret: 'SECRET_E2E' })
        .expect(200);
      expect(res.body.data.bucket).toBe('e2e-bucket');
      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.key).not.toBe('AKIA_E2E');
      // The credential never appears in the raw config.yaml.
      const raw = await api().get(`${P}/apps/${app}/config/raw`).expect(200);
      expect(raw.body.data.yaml).not.toContain('SECRET_E2E');
    });

    it('PUT /s3 blocks enabling public_url without confirmPublic (400)', async () => {
      await api()
        .put(`${P}/apps/${app}/s3`)
        .send({ public_url: 'https://cdn.example.com' })
        .expect(400);
    });

    it('PUT /s3 enables public_url with confirmPublic=true (warning surfaced)', async () => {
      const res = await api()
        .put(`${P}/apps/${app}/s3`)
        .send({ public_url: 'https://cdn.example.com', confirmPublic: true })
        .expect(200);
      expect(res.body.data.publicVods).toBe(true);
      expect(res.body.data.publicWarning).toBeTruthy();
    });
  });

  // ===========================================================================
  // samples — per-app management
  // ===========================================================================
  describe('samples', () => {
    it('GET /apps/live/samples lists sample files with embed URLs', async () => {
      const res = await api().get(`${P}/apps/live/samples`).expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const names = res.body.data.map((s: { name: string }) => s.name);
      expect(names).toContain('webrtc-publish.html');
      const one = res.body.data.find(
        (s: { name: string }) => s.name === 'webrtc-publish.html',
      );
      expect(one.embedUrl).toContain('/samples/live/');
    });

    it('GET /apps/live/samples/:file returns the file content', async () => {
      const res = await api()
        .get(`${P}/apps/live/samples/webrtc-publish.html`)
        .expect(200);
      expect(res.body.data.file).toBe('webrtc-publish.html');
      expect(res.body.data.content).toContain("const APP = 'live';");
    });

    it('GET /apps/live/samples/:file is 400 for an unsafe (non-.html) name', async () => {
      await api().get(`${P}/apps/live/samples/notes.txt`).expect(400);
    });

    it('PUT /apps/:app/samples/:file overwrites just that file', async () => {
      const res = await api()
        .put(`${P}/apps/live/samples/webrtc-publish.html`)
        .send({ content: '<h1>e2e-edited</h1>' })
        .expect(200);
      expect(res.body.data).toMatchObject({
        file: 'webrtc-publish.html',
        saved: true,
      });
      const back = await api()
        .get(`${P}/apps/live/samples/webrtc-publish.html`)
        .expect(200);
      expect(back.body.data.content).toBe('<h1>e2e-edited</h1>');
    });

    it('POST /apps/:app/samples/regenerate rebuilds the standard set', async () => {
      const res = await api()
        .post(`${P}/apps/live/samples/regenerate`)
        .expect(201);
      expect(res.body.data.regenerated).toContain('webrtc-publish.html');
      // Regeneration restored the template (overwrote our e2e edit).
      const back = await api()
        .get(`${P}/apps/live/samples/webrtc-publish.html`)
        .expect(200);
      expect(back.body.data.content).toContain("const APP = 'live';");
    });

    it('INVARIANT: editing one app\'s sample does not affect another app\'s copy', async () => {
      await api().post(`${P}/apps`).send({ name: 'e2e-iso-a' }).expect(201);
      await api().post(`${P}/apps`).send({ name: 'e2e-iso-b' }).expect(201);
      await api().post(`${P}/apps/e2e-iso-a/samples/regenerate`).expect(201);
      await api().post(`${P}/apps/e2e-iso-b/samples/regenerate`).expect(201);

      await api()
        .put(`${P}/apps/e2e-iso-a/samples/hls-player.html`)
        .send({ content: '<h1>ISO-A-ONLY</h1>' })
        .expect(200);

      const b = await api()
        .get(`${P}/apps/e2e-iso-b/samples/hls-player.html`)
        .expect(200);
      expect(b.body.data.content).not.toContain('ISO-A-ONLY');
      expect(b.body.data.content).toContain("const APP = 'e2e-iso-b';");
    });
  });
});
