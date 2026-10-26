/**
 * CAPABILITY MANIFEST TEMPLATE — StreamHub Babel (live captions & AI dubbing).
 * Design: https://streamhub.studio/docs/features/NEXTGEN-ADDONS §Babel — including the
 * worked feed-back example: captions computed on a GRID GPU node → LiveKit
 * data message on topic `plugin:babel` → player caption overlay.
 *
 * NOT DISCOVERED: folders under src/plugins/_templates/ are skipped by the
 * registry (underscore rule). To start building Babel, move this folder up
 * one level (src/plugins/babel/), then:
 *   1. create the repo-root `babel-worker/` Python package: subscribe to the
 *      room audio (livekit RTC or HLS audio), STT via faster-whisper /
 *      whisper.cpp (open-source) or a cloud STT (paid), optional translation,
 *      optional TTS dubbing published back as a NEW audio track
 *      ("<lang>-dub") into the same room;
 *   2. add the caption overlay: streamhub-web/src/plugins/babel/ — a
 *      player-overlay that renders caption cues; WebRTC players receive them
 *      as data messages (topic `plugin:babel`), HLS/MJPEG players poll the
 *      live-data channel (GET :id/live) as the fallback transport;
 *   3. dubbing track selection is player-side: subscribe the "<lang>-dub"
 *      audio track instead of the original.
 *
 * What is REAL here: the manifest, the typed config schema, the GRID
 * placement request and the spawn contract. What is TODO: babel-worker (the
 * STT/MT/TTS pipeline is NOT implemented).
 */
import * as path from 'path';
import { definePlugin } from '../../../modules/plugins/plugin.contract';

/** Repo-root `babel-worker/` package (same convention as yolo/deface). */
function workerDir(): string {
  return (
    process.env.BABEL_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'babel-worker')
  );
}

export default definePlugin({
  id: 'babel',
  name: 'StreamHub Babel',
  description:
    'In-box live captions and AI dubbing: speech-to-text on a GRID GPU node ' +
    '(whisper) or a cloud STT, optional translation, captions on the player ' +
    'and dubbed audio tracks back into the room.',
  category: 'processor',
  ui: 'player-overlay',
  needsWorker: true,
  version: '0.1.0',
  icon: 'globe',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
      required: true,
      placeholder: 'live',
      help: 'Room whose audio is transcribed.',
    },
    {
      key: 'engine',
      type: 'select',
      label: 'Speech-to-text engine',
      default: 'faster-whisper',
      options: [
        { value: 'faster-whisper', label: 'faster-whisper (open-source, GPU/CPU)' },
        { value: 'whisper-cpp', label: 'whisper.cpp (open-source, CPU-friendly)' },
        { value: 'openai-stt', label: 'OpenAI Realtime STT (paid API)' },
        { value: 'deepgram', label: 'Deepgram (paid API)' },
        { value: 'azure-stt', label: 'Azure Speech (paid API)' },
      ],
    },
    {
      key: 'modelSize',
      type: 'select',
      label: 'Whisper model size',
      default: 'small',
      options: [
        { value: 'tiny', label: 'tiny (fastest)' },
        { value: 'base', label: 'base' },
        { value: 'small', label: 'small (good default)' },
        { value: 'medium', label: 'medium' },
        { value: 'large-v3', label: 'large-v3 (best, GPU)' },
      ],
      help: 'Open-source engines only; ignored by paid APIs.',
    },
    {
      key: 'sourceLanguage',
      type: 'string',
      label: 'Source language',
      default: 'auto',
      placeholder: 'auto | es | en | pt …',
    },
    {
      key: 'targetLanguages',
      type: 'string',
      label: 'Caption target languages',
      default: '',
      placeholder: 'en,pt (empty = captions in the source language only)',
      help: 'Comma-separated ISO codes to translate captions into.',
    },
    {
      key: 'translateProvider',
      type: 'select',
      label: 'Translation provider',
      default: 'none',
      options: [
        { value: 'none', label: 'None (no translation)' },
        { value: 'nllb-local', label: 'NLLB / argos (open-source, on worker)' },
        { value: 'deepl', label: 'DeepL (paid API)' },
        { value: 'google-translate', label: 'Google Translate (paid API)' },
      ],
    },
    {
      key: 'dubbing',
      type: 'boolean',
      label: 'AI dubbing',
      default: false,
      help:
        'Synthesize translated speech and publish it as an extra audio track ' +
        '("<lang>-dub") in the room. Requires a TTS engine.',
    },
    {
      key: 'ttsEngine',
      type: 'select',
      label: 'TTS engine (dubbing)',
      default: 'none',
      options: [
        { value: 'none', label: 'None' },
        { value: 'piper', label: 'Piper (open-source, fast)' },
        { value: 'coqui-xtts', label: 'Coqui XTTS (open-source, voice-clone)' },
        { value: 'elevenlabs', label: 'ElevenLabs (paid API)' },
        { value: 'azure-tts', label: 'Azure Neural TTS (paid API)' },
      ],
    },
    {
      key: 'apiKey',
      type: 'secret',
      label: 'Provider API key',
      default: '',
      help: 'Shared key for the selected paid STT/translation/TTS provider(s).',
    },
    {
      key: 'maxCaptionDelayMs',
      type: 'number',
      label: 'Max caption delay (ms)',
      default: 1500,
      min: 250,
      max: 10000,
      help:
        'Segmenter budget: flush partial captions after this long even ' +
        'mid-sentence (latency vs completeness).',
    },
  ],
  worker: {
    // GRID: real-time whisper wants a GPU; tiny/base models keep the local
    // CPU fall-back usable until the remote scheduler ships.
    placement: 'grid',
    grid: { gpu: true, capabilities: ['whisper'] },
    spawn(ctx) {
      const dir = workerDir();
      return {
        // TODO(babel-worker): package does not exist yet — clone the
        // repo-root deface-worker layout (module `babel_worker`).
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'babel_worker', '--app', ctx.app],
        cwd: dir,
        env: {
          PYTHONPATH: dir,
          PYTHONUNBUFFERED: '1',
          BABEL_APP: ctx.app,
          BABEL_ROOM: String(ctx.config.room ?? ''),
          BABEL_ENGINE: String(ctx.config.engine ?? 'faster-whisper'),
          BABEL_MODEL_SIZE: String(ctx.config.modelSize ?? 'small'),
          BABEL_SOURCE_LANG: String(ctx.config.sourceLanguage ?? 'auto'),
          BABEL_TARGET_LANGS: String(ctx.config.targetLanguages ?? ''),
          BABEL_TRANSLATE: String(ctx.config.translateProvider ?? 'none'),
          BABEL_DUBBING: ctx.config.dubbing === true ? '1' : '0',
          BABEL_TTS: String(ctx.config.ttsEngine ?? 'none'),
          BABEL_API_KEY: String(ctx.config.apiKey ?? ''),
          BABEL_MAX_DELAY_MS: String(ctx.config.maxCaptionDelayMs ?? 1500),
          BABEL_MODEL_DIR: path.join(ctx.dataDir, 'models', 'babel'),
          BABEL_HLS_DIR: path.join(ctx.appDir, 'hls'),
          BABEL_LIVEKIT_URL: ctx.livekitUrl,
          // Captions out: LiveKit data messages on topic `plugin:babel`
          // (pluginDataTopic('babel')) for WebRTC players + the live-data
          // channel (injected STREAMHUB_INGEST_*) for HLS players.
        },
      };
    },
  },
});
