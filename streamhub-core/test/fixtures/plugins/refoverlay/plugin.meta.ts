/**
 * TEST-ONLY fixture plugin — a stable player-OVERLAY with a secret callbackUrl.
 *
 * Discovered only under STREAMHUB_PLUGIN_FIXTURE_ROOT (see refapp). It is a
 * lightweight `ui: 'player-overlay'` plugin (no worker) carrying a `callbackUrl`
 * field, so it is the stable fixture for the PUBLIC overlay endpoint specs:
 * "enabled overlays are listed for anonymous viewers, and the callback/webhook
 * URL is stripped from the public config". That previously leaned on a real
 * shipping app (yolo, a player-overlay) which now decouples — a fixture must
 * not decouple.
 *
 * `sanitizePublicConfig` iterates the SCHEMA, so both the render-safe field
 * (`model`) and the sensitive one (`callbackUrl`) MUST be declared here for the
 * strip to be exercised.
 */
import { definePlugin } from '../../../../src/modules/plugins/plugin.contract';

export default definePlugin({
  id: 'refoverlay',
  name: 'Reference Overlay (test fixture)',
  description: 'Test-only player-overlay reference plugin — never shipped.',
  category: 'processor',
  ui: 'player-overlay',
  version: '1.0.0',
  icon: 'eye',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
    },
    {
      key: 'model',
      type: 'select',
      label: 'Model size',
      default: 'nano',
      options: [
        { value: 'nano', label: 'Nano' },
        { value: 'small', label: 'Small' },
      ],
    },
    {
      key: 'confidence',
      type: 'number',
      label: 'Confidence',
      default: 0.5,
      min: 0,
      max: 1,
    },
    {
      // Render-UNSAFE: a server-to-server POST target. Stripped from the public
      // config by SENSITIVE_KEY_RE (matches /callback/).
      key: 'callbackUrl',
      type: 'string',
      label: 'Callback URL',
      default: '',
      placeholder: 'https://example.com/hooks/refoverlay',
    },
  ],
});
