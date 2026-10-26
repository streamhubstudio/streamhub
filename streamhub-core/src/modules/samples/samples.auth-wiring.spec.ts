/**
 * Unit spec — sample auth wiring (the shared `getToken` bootstrap helper).
 *
 * Regression guard for the "demos give authentication errors" bug: a sample
 * opened straight from `/samples/<app>/<file>` has NO panel session, so calling
 * the auth-required mint endpoint (POST /apps/:app/tokens, `stream:write`) 401s.
 * The shared helper must therefore resolve credentials in the only order that
 * works without a login:
 *   1) ephemeral token in the URL (#token=…)      — publish OR subscribe
 *   2) explicit management bearer (?apitoken=…)    — mint via POST /tokens
 *   3) no credential + subscribe-only              — PUBLIC play-token (no auth)
 *   4) no credential + publisher                   — actionable error, not a 401
 *
 * Pure string invariants over the in-repo TEMPLATES — nothing dials the network,
 * LiveKit, or a DB. Lives in its own file so it doesn't touch the sibling
 * samples suites (each owned separately).
 */
import { SAMPLE_FILES, TEMPLATES } from './sample-templates';

/** The shared bootstrap (incl. getToken) is inlined into every template. */
const anyTemplate = TEMPLATES['webrtc-publish.html'];

describe('samples — shared getToken auth wiring', () => {
  it('short-circuits on an ephemeral URL token before any API call', () => {
    // The ephemeral() check must precede the bearer/fetch logic.
    const ephIdx = anyTemplate.indexOf('const eph = ephemeral();');
    const fetchIdx = anyTemplate.indexOf("'/apps/' + APP + '/tokens'");
    expect(ephIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(ephIdx).toBeLessThan(fetchIdx);
  });

  it('honors an explicit ?apitoken bearer for minting', () => {
    expect(anyTemplate).toContain("qp('apitoken')");
    expect(anyTemplate).toContain("'Authorization':'Bearer ' + bearer");
  });

  it('falls back to the PUBLIC play-token for a subscribe-only page (no auth)', () => {
    expect(anyTemplate).toContain('if (opts.canPublish === false)');
    expect(anyTemplate).toContain('await playToken(opts.room');
    // The bearer branch is tried BEFORE the anonymous public fallback so an
    // operator link still mints even when public playback is disabled.
    const bearerIdx = anyTemplate.indexOf('if (bearer) {');
    const publicIdx = anyTemplate.indexOf('if (opts.canPublish === false)');
    expect(bearerIdx).toBeGreaterThan(-1);
    expect(bearerIdx).toBeLessThan(publicIdx);
  });

  it('fails a credential-less publisher with an actionable message, not a bare 401', () => {
    expect(anyTemplate).toContain('anonymous publishing is disabled');
    expect(anyTemplate).toMatch(/apitoken=sk_/);
  });

  it('the play (viewer) sample is subscribe-only so it takes the public path', () => {
    // canPublish:false routes webrtc-play through the public play-token instead
    // of the auth-required mint — the actual fix for its 401.
    expect(TEMPLATES['webrtc-play.html']).toContain('canPublish:false');
    expect(TEMPLATES['webrtc-play.html']).not.toContain('canPublish:true');
  });

  it('the publish sample is a publisher (canPublish:true)', () => {
    expect(TEMPLATES['webrtc-publish.html']).toContain('canPublish:true');
  });

  it('every template embeds the shared helper (ephemeral + public + bearer paths)', () => {
    for (const file of SAMPLE_FILES) {
      const tpl = TEMPLATES[file];
      expect(tpl).toContain('function ephemeral()');
      expect(tpl).toContain('async function playToken(');
      expect(tpl).toContain('async function getToken(');
    }
  });
});
