/**
 * Built-in Studio App: Live Control (console).
 *
 * The OPERATOR side of live-control (owner item 31): a full-page app-tab to
 * pause / resume / finish an ALREADY-LIVE stream and manage the cover assets
 * (images / looping videos) uploaded to the app S3. Backed by the in-core
 * `modules/live-control` service + per-app `live-control.db` (state machine +
 * assets + defaults) — the same shape as the `fleet` Studio App.
 *
 * This manifest is the CONSOLE only. The viewer-facing cover is a SEPARATE
 * `player-overlay` plugin (`live-control-overlay`) because the framework binds
 * one UI slot per plugin — see internal design notes (Decision 2).
 *
 * API: /apps/:app/plugins/live-control/{streams,streams/:id/{pause,resume,
 * finish},assets,settings,public}. Config below = the per-APP defaults; a
 * per-STREAM override is passed on each pause/finish call.
 *
 * Auto-discovered: the file's mere existence registers the plugin.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'live-control',
  name: 'Live Control',
  description:
    'Pause, resume or finish an already-live stream: viewers see a configured ' +
    'cover (image, looping video or text card) with audio muted until you resume.',
  category: 'tool',
  ui: 'app-tab',
  version: '1.0.0',
  icon: 'pause',
  // Studio App: in-core state machine + per-app live-control.db + full-page UI.
  // No worker to bundle → not exportable v1.
  kind: 'app',
  storage: { db: 'live-control.db' },
  // Domain events fired through the callbacks funnel (webhook + MQTT + Streamflow).
  events: ['livecontrol.paused', 'livecontrol.resumed', 'livecontrol.finished'],
  configSchema: [
    {
      key: 'defaultMode',
      type: 'select',
      label: 'Default cover mode',
      default: 'text',
      options: [
        { value: 'image', label: 'Image' },
        { value: 'video', label: 'Looping video' },
        { value: 'text', label: 'Text card' },
      ],
      help: 'What a paused/finished stream shows when no per-stream override is given.',
    },
    {
      key: 'defaultCardTitle',
      type: 'string',
      label: 'Text-card headline',
      default: 'We will be right back',
    },
    {
      key: 'defaultCardText',
      type: 'string',
      label: 'Text-card body',
      default: 'The live stream is paused.',
    },
    {
      key: 'defaultCardColor',
      type: 'string',
      label: 'Text-card background',
      default: '#0b0b0f',
      placeholder: '#RRGGBB',
    },
    {
      key: 'muteAudioServerSide',
      type: 'boolean',
      label: 'Mute audio server-side while paused',
      default: true,
      help: 'Also mute the publisher audio in LiveKit (best-effort), not just in our players.',
    },
    {
      key: 'pollSeconds',
      type: 'number',
      label: 'Overlay poll interval (seconds)',
      default: 5,
      min: 2,
      max: 60,
      help: 'How often the viewer overlay re-checks the public state (a data-channel push is instant).',
    },
  ],
});
