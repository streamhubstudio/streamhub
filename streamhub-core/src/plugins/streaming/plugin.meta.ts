/**
 * Built-in plugin: Video Streaming.
 *
 * An installable TOOL that surfaces live video streaming for an app: it reuses
 * the existing webcam publisher (browser WebRTC publish → LiveKit) and the
 * server-side RTMP egress ("transmitir") so the operator can go live to
 * YouTube/Twitch/… straight from an app section (see streamhub-web
 * src/plugins/streaming).
 *
 * No worker: the browser publishes over WebRTC and the SERVER's room-composite
 * egress forwards to RTMP — both already exposed via /apps/:app/tokens and
 * /apps/:app/broadcast. This manifest only declares the config the tool
 * pre-fills its form with.
 */
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'streaming',
  name: 'Video Streaming',
  description:
    'Go live with your webcam + mic and forward the composed room to an RTMP ' +
    'destination (YouTube, Twitch, …) via server egress.',
  category: 'tool',
  ui: 'app-tab',
  version: '1.0.0',
  icon: 'video',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room name',
      default: 'studio',
      placeholder: 'studio',
      help: 'LiveKit room the webcam publishes to and the egress composes.',
    },
    {
      key: 'defaultRtmpUrl',
      type: 'string',
      label: 'Default RTMP URL',
      default: '',
      placeholder: 'rtmp://a.rtmp.youtube.com/live2/<stream-key>',
      help: 'Optional. Pre-fills the destination field (rtmp:// or rtmps://).',
    },
    {
      key: 'audioOnly',
      type: 'boolean',
      label: 'Audio-only by default',
      default: false,
    },
  ],
});
