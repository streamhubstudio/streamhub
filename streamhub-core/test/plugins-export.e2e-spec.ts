/**
 * E2E — the Studio-App EXPORT route over the REAL AppModule with the Bearer +
 * permission guards wired and STREAMHUB_AUTHZ_ENFORCE=on (so RBAC actually
 * blocks). The worker source is a TEMP FIXTURE (STREAMHUB_WORKER_SRC_ROOT) so
 * the test never depends on the repo tree.
 *
 * Coverage:
 *   - GET /plugins list carries the new `kind` + `exportable` manifest fields.
 *   - GET :id/export → 200 application/gzip for an installed, exportable app.
 *   - 404 unknown plugin; 400 non-exportable (timestamp); 400 not-installed.
 *   - RBAC: an app-scoped token for ANOTHER app is denied (403).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootstrapTestApp, type TestApp } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';
import { DbService } from '../src/shared/db/db.service';

const P = '/api/v1';

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

describe('plugins export (e2e, AUTHZ=on)', () => {
  let app: TestApp;
  let sk: string; // global superadmin sk_ token
  let otherToken: string; // app-scoped token pinned to a DIFFERENT app
  let srcRoot: string;
  const bearer = (t: string): [string, string] => [
    'Authorization',
    `Bearer ${t}`,
  ];

  beforeAll(async () => {
    // Fixture worker source for the exportable app `refapp`
    // (STREAMHUB_WORKER_SRC_ROOT/<workerDir>/…). refapp is a synthetic FIXTURE
    // (STREAMHUB_PLUGIN_FIXTURE_ROOT) so this never depends on a real shipping
    // app that may decouple to its own repo.
    srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'export-src-'));
    const refappDir = path.join(srcRoot, 'refapp-worker', 'refapp_worker');
    fs.mkdirSync(refappDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcRoot, 'refapp-worker', 'requirements.txt'),
      'ultralytics\nopencv-python-headless\n',
    );
    fs.writeFileSync(path.join(refappDir, '__init__.py'), '# refapp worker\n');
    fs.writeFileSync(path.join(srcRoot, 'LICENSE'), 'FIXTURE LICENSE');

    app = await bootstrapTestApp({
      env: {
        STREAMHUB_AUTHZ_ENFORCE: 'on',
        STREAMHUB_WORKER_SRC_ROOT: srcRoot,
        STREAMHUB_PLUGIN_FIXTURE_ROOT: path.join(__dirname, 'fixtures', 'plugins'),
      },
    });

    const auth = app.app.get(AuthService);
    sk = (await auth.createToken({ name: 'global-ci', scope: 'global' })).token;

    // Real apps so their DBs + config exist.
    for (const name of ['parking', 'other']) {
      await app
        .request()
        .post(`${P}/apps`)
        .set(...bearer(sk))
        .send({ name })
        .expect(201);
    }
    const idOf = (name: string): number =>
      (
        app.app
          .get(DbService)
          .global()
          .prepare('SELECT id FROM apps WHERE name = ?')
          .get(name) as { id: number }
      ).id;
    otherToken = (
      await auth.createToken({
        name: 'other-key',
        scope: 'app',
        appId: idOf('other'),
      })
    ).token;

    // Install refapp (exportable) into `parking` via the real HTTP path.
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

  it('exposes kind + exportable on the plugins marketplace list', async () => {
    const res = await app
      .request()
      .get(`${P}/apps/parking/plugins`)
      .set(...bearer(sk))
      .expect(200);
    const byId = new Map<string, { kind: string; exportable: boolean }>(
      (res.body.data as Array<{ manifest: { id: string; kind: string; exportable: boolean } }>).map(
        (v) => [v.manifest.id, { kind: v.manifest.kind, exportable: v.manifest.exportable }],
      ),
    );
    expect(byId.get('refapp')).toEqual({ kind: 'app', exportable: true });
    expect(byId.get('timestamp')).toEqual({ kind: 'plugin', exportable: false });
    expect(byId.get('cockpit')).toEqual({ kind: 'app', exportable: false });
  });

  it('exports an installed, exportable app as a gzip attachment', async () => {
    const res = await app
      .request()
      .get(`${P}/apps/parking/plugins/refapp/export`)
      .set(...bearer(sk))
      .buffer()
      .parse(binaryParser)
      .expect(200);

    expect(res.headers['content-type']).toContain('application/gzip');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="streamhub-app-refapp-\d+\.\d+\.\d+\.tar\.gz"/,
    );
    // gzip magic bytes.
    expect(res.body[0]).toBe(0x1f);
    expect(res.body[1]).toBe(0x8b);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('404s exporting an unknown plugin', async () => {
    await app
      .request()
      .get(`${P}/apps/parking/plugins/does-not-exist/export`)
      .set(...bearer(sk))
      .expect(404);
  });

  it('400s exporting a non-exportable plugin (timestamp)', async () => {
    await app
      .request()
      .get(`${P}/apps/parking/plugins/timestamp/export`)
      .set(...bearer(sk))
      .expect(400);
  });

  it('400s exporting an exportable app that is not installed here (reftool)', async () => {
    // reftool is an exportable FIXTURE app NOT installed in `parking` — the
    // export fails the install gate before it ever packs a worker.
    await app
      .request()
      .get(`${P}/apps/parking/plugins/reftool/export`)
      .set(...bearer(sk))
      .expect(400);
  });

  it('403s when an app-scoped token exports ANOTHER app (RBAC, config:write)', async () => {
    await app
      .request()
      .get(`${P}/apps/parking/plugins/refapp/export`)
      .set(...bearer(otherToken))
      .expect(403);
  });
});
