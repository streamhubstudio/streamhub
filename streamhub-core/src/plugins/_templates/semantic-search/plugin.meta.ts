/**
 * CAPABILITY MANIFEST TEMPLATE — Semantic video search + auto-highlights.
 * Design: https://streamhub.studio/docs/features/NEXTGEN-ADDONS §Semantic search.
 *
 * NOT DISCOVERED: folders under src/plugins/_templates/ are skipped by the
 * registry (underscore rule). To start building, move this folder up one
 * level (src/plugins/semantic-search/), then:
 *   1. create the repo-root `semsearch-worker/` Python package: sample frames
 *      (+ audio via Babel-style STT when enabled), embed them (open_clip /
 *      SigLIP open-source, or a cloud multimodal embedding API), upsert into
 *      the vector store, and score highlight signals (motion, audio peaks,
 *      object bursts) into candidate clips;
 *   2. index storage: `sqlite-vec` inside apps/<app>/app.db keeps the
 *      per-app-SQLite invariant (default); qdrant/pgvector for scale-out;
 *   3. add the dashboard side: streamhub-web/src/plugins/semantic-search/ —
 *      an app-tab with a natural-language search box over live DVR + VODs and
 *      an auto-highlights reel (each hit deep-links into the player at ts);
 *   4. query path: an app-scoped REST route the tab calls (embed the query →
 *      k-NN → clip list) — TODO seam, see NEXTGEN-ADDONS.md.
 *
 * What is REAL here: the manifest, the typed config schema, the GRID
 * placement request and the spawn contract. What is TODO: semsearch-worker
 * (embeddings/highlights are NOT implemented) and the query route.
 */
import * as path from 'path';
import { definePlugin } from '../../../modules/plugins/plugin.contract';

/** Repo-root `semsearch-worker/` package (same convention as yolo/deface). */
function workerDir(): string {
  return (
    process.env.SEMSEARCH_WORKER_DIR ??
    path.resolve(__dirname, '..', '..', '..', '..', 'semsearch-worker')
  );
}

export default definePlugin({
  id: 'semantic-search',
  name: 'Semantic Search & Highlights',
  description:
    'Natural-language search over live streams and VODs (CLIP-style ' +
    'embeddings + vector store) with automatic highlight clip detection.',
  category: 'processor',
  ui: 'app-tab',
  needsWorker: true,
  version: '0.1.0',
  icon: 'search',
  configSchema: [
    {
      key: 'room',
      type: 'string',
      label: 'Room / stream',
      default: '',
      placeholder: 'live (empty = every room of the app)',
      help: 'Which room to index; empty indexes all rooms.',
    },
    {
      key: 'embedder',
      type: 'select',
      label: 'Embedding model',
      default: 'open-clip',
      options: [
        { value: 'open-clip', label: 'OpenCLIP (open-source, GPU/CPU)' },
        { value: 'siglip', label: 'SigLIP (open-source)' },
        { value: 'cloud-multimodal', label: 'Cloud multimodal embeddings (paid API)' },
      ],
    },
    {
      key: 'vectorStore',
      type: 'select',
      label: 'Vector store',
      default: 'sqlite-vec',
      options: [
        { value: 'sqlite-vec', label: 'sqlite-vec in apps/<app>/app.db (default)' },
        { value: 'qdrant', label: 'Qdrant (self-hosted)' },
        { value: 'pgvector', label: 'Postgres + pgvector' },
      ],
      help:
        'sqlite-vec keeps the per-app SQLite invariant; external stores are ' +
        'for large libraries.',
    },
    {
      key: 'sampleIntervalSec',
      type: 'number',
      label: 'Frame sample interval (s)',
      default: 2,
      min: 0.5,
      max: 60,
      help: 'One embedded frame every N seconds of stream.',
    },
    {
      key: 'indexAudio',
      type: 'boolean',
      label: 'Index speech (via STT)',
      default: false,
      help:
        'Also transcribe and embed speech so queries match spoken content ' +
        '(reuses the Babel STT stack on the same worker/node).',
    },
    {
      key: 'highlights',
      type: 'boolean',
      label: 'Auto-highlights',
      default: true,
      help: 'Score and clip highlight candidates while indexing.',
    },
    {
      key: 'highlightSignals',
      type: 'string',
      label: 'Highlight signals',
      default: 'motion,audio-peaks,object-burst',
      help:
        'Comma-separated detectors that vote for a highlight (motion energy, ' +
        'audio loudness peaks, sudden object-count changes).',
    },
    {
      key: 'apiKey',
      type: 'secret',
      label: 'Provider API key',
      default: '',
      help: 'Only for the cloud embedding provider; ignored otherwise.',
    },
  ],
  worker: {
    // GRID: embedding throughput scales with GPU; CPU fall-back works at low
    // sample rates until the remote scheduler ships.
    placement: 'grid',
    grid: { gpu: true, capabilities: ['clip'] },
    spawn(ctx) {
      const dir = workerDir();
      return {
        // TODO(semsearch-worker): package does not exist yet — clone the
        // repo-root yolo-worker layout (module `semsearch_worker`).
        command: process.env.PLUGIN_PYTHON ?? 'python3',
        args: ['-m', 'semsearch_worker', '--app', ctx.app],
        cwd: dir,
        env: {
          PYTHONPATH: dir,
          PYTHONUNBUFFERED: '1',
          SEMSEARCH_APP: ctx.app,
          SEMSEARCH_ROOM: String(ctx.config.room ?? ''),
          SEMSEARCH_EMBEDDER: String(ctx.config.embedder ?? 'open-clip'),
          SEMSEARCH_VECTOR_STORE: String(ctx.config.vectorStore ?? 'sqlite-vec'),
          SEMSEARCH_SAMPLE_SEC: String(ctx.config.sampleIntervalSec ?? 2),
          SEMSEARCH_INDEX_AUDIO: ctx.config.indexAudio === true ? '1' : '0',
          SEMSEARCH_HIGHLIGHTS: ctx.config.highlights === false ? '0' : '1',
          SEMSEARCH_SIGNALS: String(
            ctx.config.highlightSignals ?? 'motion,audio-peaks,object-burst',
          ),
          SEMSEARCH_API_KEY: String(ctx.config.apiKey ?? ''),
          SEMSEARCH_MODEL_DIR: path.join(ctx.dataDir, 'models', 'semsearch'),
          SEMSEARCH_APP_DB: path.join(ctx.appDir, 'app.db'),
          SEMSEARCH_HLS_DIR: path.join(ctx.appDir, 'hls'),
          SEMSEARCH_LIVEKIT_URL: ctx.livekitUrl,
          // Results out: highlight events as data messages on topic
          // `plugin:semantic-search`; index rows written to the vector store.
        },
      };
    },
  },
});
