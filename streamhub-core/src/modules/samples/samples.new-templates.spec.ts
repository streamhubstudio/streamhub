/**
 * Unit spec — G4 turnkey vertical samples (CCTV / live-shopping / telemedicine /
 * radio / conference).
 *
 * Exercises REAL per-app generation via SamplesService.generate against a
 * migrated temp DB (harness `makeUnitContext`) with a genuine AppsService
 * collaborator — the same harness as samples.service.spec.ts, kept in its own
 * file so the G4 suite is self-contained and does not touch the sibling suite.
 *
 * Locks down:
 *   - each new template file is generated for the app,
 *   - every known placeholder ({{APP}}/{{ROOM}}/{{WS_URL}}/{{API_URL}}/…)
 *     resolves to the target app (no leftover tokens),
 *   - the intended wiring is present (public play/listen tokens, ephemeral
 *     creds, chat/reactions data channel, camera grid…).
 */
import * as fs from 'fs';
import * as path from 'path';

import { SamplesService } from './samples.service';
import { SAMPLE_FILES, TEMPLATES } from './sample-templates';
import { AppsService } from '../apps/apps.service';
import { S3Service } from '../s3/s3.service';
import { SecretsStore } from '../s3/secrets.store';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

const NEW_SAMPLES = [
  'cctv-grid.html',
  'live-shopping.html',
  'telemedicine.html',
  'radio-player.html',
  'conference.html',
] as const;

describe('SamplesService — G4 vertical templates', () => {
  let ctx: UnitContext;
  let apps: AppsService;
  let samples: SamplesService;

  const sampleDir = (app: string): string =>
    path.join(apps.appDir(app), 'samples');
  const onDisk = (app: string, file: string): string =>
    fs.readFileSync(path.join(sampleDir(app), file), 'utf8');

  beforeEach(async () => {
    ctx = makeUnitContext();
    const s3 = new S3Service();
    const secrets = new SecretsStore(ctx.config);
    const moduleRef = {
      get: () => ({ generate: async () => [] }),
    } as unknown as never;
    apps = ctx.newService(AppsService, ctx.config, ctx.db, s3, secrets, moduleRef);
    samples = ctx.newService(SamplesService, ctx.config, apps);

    await apps.create({ name: 'shop', displayName: 'Shop' });
    await samples.generate('shop');
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('registers the 5 verticals in the standard sample set', () => {
    for (const f of NEW_SAMPLES) {
      expect(SAMPLE_FILES as readonly string[]).toContain(f);
    }
  });

  it.each(NEW_SAMPLES)('generates %s wired to the app (no leftover tokens)', (file) => {
    const full = path.join(sampleDir('shop'), file);
    expect(fs.existsSync(full)).toBe(true);
    const html = onDisk('shop', file);

    // Resolved to THIS app; no unresolved known placeholders.
    expect(html).toContain("const APP = 'shop';");
    expect(html).not.toContain('{{APP}}');
    expect(html).not.toContain('{{ROOM}}');
    expect(html).not.toContain('{{WS_URL}}');
    expect(html).not.toContain('{{API_URL}}');
    expect(html).not.toContain('{{ADAPTOR_URL}}');
    expect(html).not.toContain('{{HLS_URL}}');
    // A self-contained document.
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('CCTV grid subscribes to N rooms with the public play token', () => {
    const html = onDisk('shop', 'cctv-grid.html');
    expect(html).toContain('playToken(');
    expect(html).toContain('TrackSubscribed');
    expect(html).toContain("split(',')"); // comma-separated room list → grid
  });

  it('live-shopping wires the chat/reactions data channel + a buy button', () => {
    const html = onDisk('shop', 'live-shopping.html');
    expect(html).toContain('DataReceived');
    expect(html).toContain('publishData');
    expect(html).toContain("topic:'reaction'");
    expect(html).toContain("id=\"buy\"");
    // Watches via public play token (chat receive) with ephemeral upgrade.
    expect(html).toContain('playToken(');
    expect(html).toContain('ephemeral()');
  });

  it('telemedicine is a 1:1 room driven by an ephemeral token', () => {
    const html = onDisk('shop', 'telemedicine.html');
    expect(html).toContain('ephemeral()');
    expect(html).toContain('enableCameraAndMicrophone');
    // Shows the operator how to mint a per-party ephemeral token.
    expect(html).toContain('/apps/shop/tokens');
  });

  it('radio-player is an audio-only listener on the public listen token', () => {
    const html = onDisk('shop', 'radio-player.html');
    expect(html).toContain('radioListenToken(');
    expect(html).toContain("t.kind==='audio'");
    expect(html).not.toContain('enableCameraAndMicrophone');
  });

  it('conference is an N-to-N meeting with a participant tile grid', () => {
    const html = onDisk('shop', 'conference.html');
    expect(html).toContain('enableCameraAndMicrophone');
    expect(html).toContain('setScreenShareEnabled');
    expect(html).toContain('tileFor(');
    expect(html).toContain('ParticipantDisconnected');
  });

  it('resolves {{ROOM}} to the app room prefix, not the literal token', () => {
    // Default room prefix == app name for a freshly-created app.
    const html = onDisk('shop', 'cctv-grid.html');
    expect(html).toContain('value="shop"');
  });

  // INVARIANT — livekit-client CDN pin. server 1.8.4 <-> client 2.15.7 is the
  // validated pair; an unpinned/major-floating jsdelivr URL silently upgrades the
  // client on the next publish (2.20+ today) and breaks publishing against the
  // pinned server. Lock every CDN reference to the exact pinned version.
  describe('livekit-client CDN pin', () => {
    // Matches any jsdelivr livekit-client script URL; group 1 = the version
    // spec after `@`, or undefined when the URL is unpinned.
    const CDN_RE = /cdn\.jsdelivr\.net\/npm\/livekit-client(?:@([^/]+))?\//g;

    it('every template pins a livekit-client CDN URL to exactly 2.15.7', () => {
      const offenders: string[] = [];
      for (const [name, tpl] of Object.entries(TEMPLATES)) {
        for (const m of tpl.matchAll(CDN_RE)) {
          if (m[1] !== '2.15.7') offenders.push(`${name}: ${m[0]}`);
        }
      }
      // No unpinned (`livekit-client/`) or major-floating (`livekit-client@2/`)
      // references may exist anywhere in the template set.
      expect(offenders).toEqual([]);
    });

    it('the WebRTC templates actually reference the pinned client (regex sanity)', () => {
      // Guards against the invariant above vacuously passing if the CDN URL is
      // renamed/removed: these publish/subscribe pages MUST ship livekit-client.
      expect(TEMPLATES['webrtc-publish.html']).toContain('livekit-client@2.15.7/');
      expect(TEMPLATES['webrtc-play.html']).toContain('livekit-client@2.15.7/');
    });
  });
});
