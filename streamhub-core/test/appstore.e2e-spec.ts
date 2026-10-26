/**
 * E2E — the appstore version store + per-app pin/rollback over the REAL
 * AppModule with the Bearer + permission guards wired (STREAMHUB_AUTHZ_ENFORCE=on)
 * and a cluster token set. The worker source is a TEMP FIXTURE
 * (STREAMHUB_WORKER_SRC_ROOT) so built-ins materialize at boot without the repo
 * tree, and the upload payload is the builtin bundle re-posted as a new semver.
 *
 * Coverage:
 *   - built-ins materialize at boot → GET /plugins/:id/versions lists builtin.
 *   - upload a new version (multipart) → 200; dupe → 409; bad semver → 400.
 *   - download: sk_ superadmin OK, X-Cluster-Token OK, wrong token → 401.
 *   - superadmin gate: an app-scoped token cannot upload (403).
 *   - pin → GET :id/versions active; delete pinned → 409; unpin → delete OK.
 *   - rollback repins to the previous version.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootstrapTestApp, type TestApp } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';
import { DbService } from '../src/shared/db/db.service';

const P = '/api/v1';
const CLUSTER_TOKEN = 'test-cluster-secret';

/** Collect the raw response bytes (supertest won't JSON-parse a gzip body). */
function binaryParser(
  res: NodeJS.ReadableStream & { setEncoding: (e: string) => void },
  cb: (err: Error | null, body: Buffer) => void,
): void {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => cb(null, Buffer.from(data, 'binary')));
}

describe('appstore versioning (e2e, AUTHZ=on)', () => {
  let app: TestApp;
  let sk: string;
  let appToken: string;
  let srcRoot: string;
  let builtin: string;
  let bundle: Buffer;
  const bearer = (t: string): [string, string] => ['Authorization', `Bearer ${t}`];

  beforeAll(async () => {
    // Fixture worker source for the exportable app `refapp` so its builtin
    // version materializes at boot. refapp is a synthetic FIXTURE
    // (STREAMHUB_PLUGIN_FIXTURE_ROOT) — never a real shipping app that may
    // decouple to its own repo.
    srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'appstore-e2e-'));
    const refappDir = path.join(srcRoot, 'refapp-worker', 'refapp_worker');
    fs.mkdirSync(refappDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'refapp-worker', 'requirements.txt'),
      'ultralytics\n',
    );
    fs.writeFileSync(path.join(refappDir, '__init__.py'), '# refapp\n');
    fs.writeFileSync(path.join(srcRoot, 'LICENSE'), 'FIXTURE LICENSE');

    app = await bootstrapTestApp({
      env: {
        STREAMHUB_AUTHZ_ENFORCE: 'on',
        STREAMHUB_WORKER_SRC_ROOT: srcRoot,
        STREAMHUB_CLUSTER_TOKEN: CLUSTER_TOKEN,
        STREAMHUB_PLUGIN_FIXTURE_ROOT: path.join(__dirname, 'fixtures', 'plugins'),
      },
    });

    const auth = app.app.get(AuthService);
    sk = (await auth.createToken({ name: 'global-ci', scope: 'global' })).token;

    await app.request().post(`${P}/apps`).set(...bearer(sk)).send({ name: 'parking' }).expect(201);
    const appId = (
      app.app
        .get(DbService)
        .global()
        .prepare('SELECT id FROM apps WHERE name = ?')
        .get('parking') as { id: number }
    ).id;
    appToken = (
      await auth.createToken({ name: 'app-key', scope: 'app', appId })
    ).token;

    await app
      .request()
      .post(`${P}/apps/parking/plugins/refapp/install`)
      .set(...bearer(sk))
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(srcRoot, { recursive: true, force: true });
    // Don't leak the fixture-root into sibling e2e suites (shared jest worker).
    delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  });

  it('lists the builtin version materialized at boot', async () => {
    const res = await app
      .request()
      .get(`${P}/plugins/refapp/versions`)
      .set(...bearer(sk))
      .expect(200);
    builtin = res.body.data.builtinVersion;
    expect(builtin).toMatch(/^builtin-/);
    const only = res.body.data.versions.find(
      (v: { version: string }) => v.version === builtin,
    );
    expect(only.source).toBe('builtin');
    expect(only.builtin).toBe(true);
  });

  it('downloads the builtin bundle with a superadmin sk_', async () => {
    const res = await app
      .request()
      .get(`${P}/plugins/refapp/versions/${builtin}/bundle`)
      .set(...bearer(sk))
      .buffer()
      .parse(binaryParser)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/gzip');
    expect(res.headers['x-bundle-sha256']).toHaveLength(64);
    expect(res.body[0]).toBe(0x1f);
    expect(res.body[1]).toBe(0x8b);
    bundle = res.body; // reused as the upload payload
  });

  it('downloads the bundle with an X-Cluster-Token (node fetch)', async () => {
    await app
      .request()
      .get(`${P}/plugins/refapp/versions/${builtin}/bundle`)
      .set('X-Cluster-Token', CLUSTER_TOKEN)
      .buffer()
      .parse(binaryParser)
      .expect(200);
  });

  it('rejects a bundle download with a wrong cluster token (401)', async () => {
    await app
      .request()
      .get(`${P}/plugins/refapp/versions/${builtin}/bundle`)
      .set('X-Cluster-Token', 'wrong')
      .expect(401);
  });

  it('uploads a new version (multipart) and rejects a duplicate (409)', async () => {
    const res = await app
      .request()
      .post(`${P}/plugins/refapp/versions`)
      .set(...bearer(sk))
      .field('version', '2.9.0')
      .field('notes', 'custom build')
      .attach('bundle', bundle, 'refapp-2.9.0.tar.gz')
      .expect(201);
    expect(res.body.data).toMatchObject({ version: '2.9.0', source: 'uploaded' });
    expect(res.body.data.sha256).toHaveLength(64);

    await app
      .request()
      .post(`${P}/plugins/refapp/versions`)
      .set(...bearer(sk))
      .field('version', '2.9.0')
      .attach('bundle', bundle, 'refapp-2.9.0.tar.gz')
      .expect(409);
  });

  it('rejects an upload with a non-semver version (400)', async () => {
    await app
      .request()
      .post(`${P}/plugins/refapp/versions`)
      .set(...bearer(sk))
      .field('version', 'not-a-semver')
      .attach('bundle', bundle, 'x.tar.gz')
      .expect(400);
  });

  it('denies an app-scoped token from uploading (superadmin only, 403)', async () => {
    await app
      .request()
      .post(`${P}/plugins/refapp/versions`)
      .set(...bearer(appToken))
      .field('version', '3.0.0')
      .attach('bundle', bundle, 'x.tar.gz')
      .expect(403);
  });

  it('pins an install, then refuses to delete the pinned version (409)', async () => {
    const pinned = await app
      .request()
      .put(`${P}/apps/parking/plugins/refapp/version`)
      .set(...bearer(sk))
      .send({ version: '2.9.0' })
      .expect(200);
    expect(pinned.body.data.active).toBe('2.9.0');

    const view = await app
      .request()
      .get(`${P}/apps/parking/plugins/refapp/versions`)
      .set(...bearer(sk))
      .expect(200);
    expect(view.body.data.active).toBe('2.9.0');
    expect(view.body.data.effective).toBe('2.9.0');

    // Pinned → delete refused.
    await app
      .request()
      .delete(`${P}/plugins/refapp/versions/2.9.0`)
      .set(...bearer(sk))
      .expect(409);
  });

  it('rolls back to the built-in, then the version deletes cleanly', async () => {
    const rolled = await app
      .request()
      .post(`${P}/apps/parking/plugins/refapp/version/rollback`)
      .set(...bearer(sk))
      .expect(201);
    expect(rolled.body.data.active).toBeNull(); // rolled back to builtin/latest

    await app
      .request()
      .delete(`${P}/plugins/refapp/versions/2.9.0`)
      .set(...bearer(sk))
      .expect(200);
  });

  it('refuses to delete a built-in version (400)', async () => {
    await app
      .request()
      .delete(`${P}/plugins/refapp/versions/${builtin}`)
      .set(...bearer(sk))
      .expect(400);
  });
});
