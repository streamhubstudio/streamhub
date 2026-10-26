/**
 * TEST-ONLY fixture — a stable stand-in for the DECOUPLED `transcription` app.
 *
 * Unlike the other decoupled apps, the core module `modules/transcription` (the
 * VOD → audio → SRT flow, which STAYS in core) resolves the plugin's config via
 * `registry.getMeta('transcription')`. Its unit tests therefore need a
 * `transcription` meta present even though the real app now lives in its own
 * repo and is only discovered when COMPOSED (apps-pull). This fixture (id +
 * config schema mirror the real app) is discovered only under
 * STREAMHUB_PLUGIN_FIXTURE_ROOT, so it stands in for the real app in hermetic
 * core-module tests without the real app ever having to stay in-tree.
 *
 * Keep the config keys in sync with streamhub-app-transcription's manifest — the
 * core flow reads provider/model/openaiModel/language/autoTranscribe/apiKey/device.
 */
import { definePlugin } from '../../../../src/modules/plugins/plugin.contract';

export default definePlugin({
  id: 'transcription',
  name: 'VOD Transcription',
  description: 'Test fixture standing in for the decoupled transcription app.',
  category: 'processor',
  ui: 'panel',
  needsWorker: true,
  version: '1.0.0',
  kind: 'app',
  icon: 'subtitles',
  configSchema: [
    {
      key: 'provider',
      type: 'select',
      label: 'Transcription engine',
      default: 'local',
      options: [
        { value: 'local', label: 'Local Whisper' },
        { value: 'openai', label: 'OpenAI API' },
      ],
    },
    {
      key: 'model',
      type: 'select',
      label: 'Whisper model (local)',
      default: 'small',
      options: [
        { value: 'tiny', label: 'tiny' },
        { value: 'base', label: 'base' },
        { value: 'small', label: 'small' },
        { value: 'medium', label: 'medium' },
        { value: 'large-v3', label: 'large-v3' },
      ],
    },
    {
      key: 'openaiModel',
      type: 'select',
      label: 'OpenAI model',
      default: 'whisper-1',
      options: [
        { value: 'whisper-1', label: 'whisper-1' },
        { value: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
        { value: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe' },
      ],
    },
    { key: 'language', type: 'string', label: 'Language', default: 'auto' },
    { key: 'autoTranscribe', type: 'boolean', label: 'Auto-transcribe new VODs', default: true },
    { key: 'apiKey', type: 'secret', label: 'OpenAI API key', default: '' },
    {
      key: 'device',
      type: 'select',
      label: 'Compute device (local)',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'cpu', label: 'CPU' },
        { value: 'cuda', label: 'CUDA' },
      ],
    },
  ],
  worker: {
    // Not exercised by the core-module tests (the worker exchanges FILE-based
    // jobs); a trivial spawn keeps this a valid worker app.
    spawn(ctx) {
      return {
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'transcription_worker', '--app', ctx.app],
        env: { TRANSCRIBE_APP: ctx.app },
      };
    },
  },
});
