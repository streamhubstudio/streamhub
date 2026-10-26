/**
 * StreamHub MCP tool catalogue.
 *
 * Every ToolDef maps one MCP tool to exactly ONE StreamHub REST endpoint —
 * names and parameters are derived from `streamhub-docs/api/openapi.json`
 * (the authoritative API surface), not invented. Handlers are thin pure
 * wrappers over the HttpClient so the tool→endpoint mapping is unit-testable
 * without any MCP plumbing or network.
 *
 * Destructive operations (delete app, delete VOD, db purge) are:
 *   1. NOT registered at all unless the server runs with
 *      `--allow-destructive` / STREAMHUB_ALLOW_DESTRUCTIVE=true, and
 *   2. even then require a literal `confirm: true` argument, so a model
 *      must obtain explicit user approval before calling them.
 */
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { defined, type HttpClient } from './client.ts';

export type ToolGroup =
  | 'system'
  | 'apps'
  | 'presets'
  | 'streams'
  | 'rooms'
  | 'tags'
  | 'ingress'
  | 'recording'
  | 'vods'
  | 'plugins'
  | 'live-control'
  | 'stream-health'
  | 'streamflow'
  | 'tokens'
  | 'maintenance';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  /** What it does + the endpoint it calls (so the model knows the semantics). */
  description: string;
  group: ToolGroup;
  /** Gated behind --allow-destructive / STREAMHUB_ALLOW_DESTRUCTIVE (default off). */
  destructive?: boolean;
  annotations?: ToolAnnotations;
  inputSchema: ZodRawShape;
  handler: (client: HttpClient, args: Record<string, any>) => Promise<unknown>;
}

const enc = encodeURIComponent;

const appParam = () => z.string().describe('App slug, e.g. "live".');

const confirmParam = () =>
  z
    .literal(true)
    .describe(
      'Must be literally true. Only pass it after the user has EXPLICITLY approved this destructive operation in the conversation.',
    );

/** Second gate: destructive handlers refuse to run without confirm === true. */
function requireConfirm(args: Record<string, unknown>): void {
  if (args.confirm !== true) {
    throw new Error(
      'Destructive operation not confirmed. Ask the user for explicit approval, then retry with confirm: true.',
    );
  }
}

const READ = { readOnlyHint: true } as const;
const DESTROY = { destructiveHint: true } as const;

export const TOOLS: ToolDef[] = [
  // ── System / observability ────────────────────────────────────────────────
  {
    name: 'get_health',
    title: 'Health check',
    description:
      'Liveness probe of the StreamHub core (GET /api/v1/health). Public endpoint — a quick way to verify the base URL is right.',
    group: 'system',
    annotations: READ,
    inputSchema: {},
    handler: (c) => c.get('/health'),
  },
  {
    name: 'get_system_stats',
    title: 'Server stats',
    description:
      'Global server statistics: apps, live streams, system resources (GET /api/v1/stats).',
    group: 'system',
    annotations: READ,
    inputSchema: {},
    handler: (c) => c.get('/stats'),
  },
  {
    name: 'query_logs',
    title: 'Query server logs',
    description:
      'Query the server logs with filters (GET /api/v1/logs). Useful for diagnosing ingest/recording problems; filter by app to scope to one app.',
    group: 'system',
    annotations: READ,
    inputSchema: {
      level: z
        .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .optional()
        .describe('Minimum log level.'),
      q: z.string().optional().describe('Full-text search over the message.'),
      app: z.string().optional().describe('Restrict to one app slug.'),
      source: z.string().optional().describe('Log source/module filter.'),
      since: z.string().optional().describe('ISO date lower bound.'),
      until: z.string().optional().describe('ISO date upper bound.'),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    },
    handler: (c, a) =>
      c.get('/logs', {
        query: {
          level: a.level,
          q: a.q,
          app: a.app,
          source: a.source,
          since: a.since,
          until: a.until,
          limit: a.limit,
          offset: a.offset,
        },
      }),
  },

  // ── Apps ──────────────────────────────────────────────────────────────────
  {
    name: 'list_apps',
    title: 'List apps',
    description:
      'List the apps (tenant-scoped multi-tenant units) visible to the token (GET /api/v1/apps).',
    group: 'apps',
    annotations: READ,
    inputSchema: {},
    handler: (c) => c.get('/apps'),
  },
  {
    name: 'get_app',
    title: 'Get app',
    description: 'Get one app by slug, with its resolved config (GET /api/v1/apps/{name}).',
    group: 'apps',
    annotations: READ,
    inputSchema: { name: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.name)}`),
  },
  {
    name: 'create_app',
    title: 'Create app',
    description:
      'Create a new app: scaffolds directories, config.yaml, per-app DB and sample pages (POST /api/v1/apps).',
    group: 'apps',
    inputSchema: {
      name: z.string().describe('Unique app slug, e.g. "live".'),
      displayName: z.string().optional().describe('Human display name.'),
      roomPrefix: z.string().optional().describe('LiveKit room prefix (defaults to the slug).'),
    },
    handler: (c, a) =>
      c.post(
        '/apps',
        defined({ name: a.name, displayName: a.displayName, roomPrefix: a.roomPrefix }),
      ),
  },
  {
    name: 'update_app',
    title: 'Update app config',
    description:
      "Patch an app's config.yaml — display name, recording, callbacks (PATCH /api/v1/apps/{name}). Returns the merged resolved config.",
    group: 'apps',
    inputSchema: {
      name: appParam(),
      displayName: z.string().optional(),
      roomPrefix: z.string().optional().describe('LiveKit room prefix.'),
      recordingEnabled: z.boolean().optional().describe('Enable/disable recording for the app.'),
      splitMinutes: z
        .number()
        .optional()
        .describe('Split recordings into N-minute MP4 parts (0/15/30/60/90/120; 0 = single file).'),
      snapshotSeconds: z
        .number()
        .optional()
        .describe('JPEG snapshot every N seconds while recording (0/1/30/60/120/360; 0 = off).'),
      filenameTemplate: z
        .string()
        .optional()
        .describe(
          'Filename/S3-key template for recordings (${} dialect: ${app} ${streamId} ${room} ${type} ${ts} ${date:yyyy-MM-dd} ${var.NAME}). Empty = built-in naming.',
        ),
      snapshotTemplate: z
        .string()
        .optional()
        .describe(
          'Filename/S3-key template for snapshots (same ${} dialect; ${type} = jpg). Empty = built-in naming.',
        ),
      retentionDays: z
        .number()
        .int()
        .optional()
        .describe(
          'VOD retention window in days (0/7/30/90/180/360; 0 = keep forever). A periodic janitor deletes VODs older than this from the app DB AND its S3 storage.',
        ),
      variables: z
        .record(z.string())
        .optional()
        .describe(
          'Per-app plain-config variables (WHOLE-MAP REPLACE — send the full desired set), referenced from filename/snapshot templates as ${var.NAME}. Keys must be [A-Za-z0-9_]. NOT secrets.',
        ),
      callbackUrl: z.string().optional().describe('Outbound webhook callback URL.'),
      callbackSecret: z.string().optional().describe('Shared secret used to sign callbacks.'),
    },
    handler: (c, a) =>
      c.patch(
        `/apps/${enc(a.name)}`,
        defined({
          displayName: a.displayName,
          roomPrefix: a.roomPrefix,
          recordingEnabled: a.recordingEnabled,
          splitMinutes: a.splitMinutes,
          snapshotSeconds: a.snapshotSeconds,
          filenameTemplate: a.filenameTemplate,
          snapshotTemplate: a.snapshotTemplate,
          retentionDays: a.retentionDays,
          variables: a.variables,
          callbackUrl: a.callbackUrl,
          callbackSecret: a.callbackSecret,
        }),
      ),
  },
  {
    name: 'get_app_stats',
    title: 'App stats',
    description:
      'Per-app stats: live streams/viewers, VOD counts/storage, ingress and a 24h log rollup (GET /api/v1/apps/{app}/stats).',
    group: 'apps',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/stats`),
  },
  {
    name: 'get_app_sizes',
    title: 'App storage footprint',
    description:
      "This app's storage footprint: app.db size + total VOD bytes (GET /api/v1/apps/{name}/sizes).",
    group: 'apps',
    annotations: READ,
    inputSchema: { name: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.name)}/sizes`),
  },
  {
    name: 'delete_app',
    title: 'Delete app (DESTRUCTIVE)',
    description:
      'Permanently delete an app, optionally purging its VODs and local files (DELETE /api/v1/apps/{name}). DESTRUCTIVE — requires explicit user confirmation.',
    group: 'apps',
    destructive: true,
    annotations: DESTROY,
    inputSchema: {
      name: appParam(),
      deleteVods: z.boolean().optional().describe('Also purge the app VODs/local files.'),
      confirm: confirmParam(),
    },
    handler: (c, a) => {
      requireConfirm(a);
      return c.del(`/apps/${enc(a.name)}`, { query: { deleteVods: a.deleteVods } });
    },
  },

  // ── App config: presets ──────────────────────────────────────────────────────
  {
    name: 'list_presets',
    title: 'List config presets',
    description:
      "List the built-in declarative delivery/quality profiles (low-latency / high-quality-recording / mass-audience-HLS / rtmp-passthrough) with what each one sets, and whether it is currently `applied` to the app (GET /api/v1/apps/{app}/presets).",
    group: 'presets',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/presets`),
  },
  {
    name: 'apply_preset',
    title: 'Apply config preset',
    description:
      "Deep-merge a preset's partial config over the app's config.yaml, take a timestamped backup, write it and hot-reload the app in place — no process restart, no cut streams (POST /api/v1/apps/{app}/presets/{preset}/apply). Returns the diff.",
    group: 'presets',
    inputSchema: { app: appParam(), preset: z.string().describe('Preset id, e.g. "low-latency".') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/presets/${enc(a.preset)}/apply`),
  },
  {
    name: 'deactivate_preset',
    title: 'Deactivate config preset',
    description:
      "Revert a preset's keys to their factory defaults (or remove forward-looking keys with no default), backup + hot-reload (POST /api/v1/apps/{app}/presets/{preset}/deactivate). Returns the diff.",
    group: 'presets',
    inputSchema: { app: appParam(), preset: z.string().describe('Preset id, e.g. "low-latency".') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/presets/${enc(a.preset)}/deactivate`),
  },

  // ── Streams ───────────────────────────────────────────────────────────────
  {
    name: 'list_streams',
    title: 'List live streams',
    description: 'List the active streams of an app (GET /api/v1/apps/{app}/streams).',
    group: 'streams',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/streams`),
  },
  {
    name: 'get_stream',
    title: 'Get stream',
    description:
      'Detail of one active stream, including viewers (GET /api/v1/apps/{app}/streams/{id}). Stream ids may contain "/" — pass them verbatim, encoding is handled.',
    group: 'streams',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Stream id (may contain "/").') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/streams/${enc(a.id)}`),
  },
  {
    name: 'stop_stream',
    title: 'Stop stream',
    description:
      'Stop a live stream (DELETE /api/v1/apps/{app}/streams/{id}). This interrupts a live broadcast — use only when the user asked for it.',
    group: 'streams',
    annotations: DESTROY,
    inputSchema: { app: appParam(), id: z.string().describe('Stream id (may contain "/").') },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/streams/${enc(a.id)}`),
  },
  {
    name: 'snapshot_stream',
    title: 'On-demand snapshot (by stream id)',
    description:
      'Capture a JPEG snapshot right now, by stream id — works for LiveKit-backed streams (room composite) AND passthrough/HLS streams (latest on-disk HLS segment) (POST /api/v1/apps/{app}/streams/{id}/snapshot). Returns { key, url }; fires stream.snapshot. 503 when there is no live source.',
    group: 'streams',
    inputSchema: { app: appParam(), id: z.string().describe('Stream id (may contain "/").') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/streams/${enc(a.id)}/snapshot`),
  },
  {
    name: 'snapshot_room',
    title: 'On-demand snapshot (by room)',
    description:
      'Capture a JPEG snapshot right now, by room name (POST /api/v1/apps/{app}/snapshots). Returns { key, url }; fires stream.snapshot. Prefer snapshot_stream when you already know the stream id.',
    group: 'streams',
    inputSchema: {
      app: appParam(),
      room: z.string().describe('LiveKit room name to snapshot.'),
      participantIdentity: z
        .string()
        .optional()
        .describe('Snapshot one participant instead of the room composite.'),
    },
    handler: (c, a) =>
      c.post(`/apps/${enc(a.app)}/snapshots`, defined({ room: a.room, participantIdentity: a.participantIdentity })),
  },

  // ── Rooms & moderation (LiveKit native) ───────────────────────────────────
  {
    name: 'list_rooms',
    title: 'List live rooms',
    description:
      "List the app's live rooms with participant counts and metadata (GET /api/v1/apps/{app}/rooms).",
    group: 'rooms',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/rooms`),
  },
  {
    name: 'get_room',
    title: 'Get live room',
    description:
      'One live room with its metadata; 404 if not currently active (GET /api/v1/apps/{app}/rooms/{room}).',
    group: 'rooms',
    annotations: READ,
    inputSchema: { app: appParam(), room: z.string().describe('Room name.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/rooms/${enc(a.room)}`),
  },
  {
    name: 'list_participants',
    title: 'List room participants',
    description:
      "The room's participants with their published tracks (sids) and grants — feeds the moderation actions (GET /api/v1/apps/{app}/rooms/{room}/participants).",
    group: 'rooms',
    annotations: READ,
    inputSchema: { app: appParam(), room: z.string() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/rooms/${enc(a.room)}/participants`),
  },
  {
    name: 'kick_participant',
    title: 'Kick participant',
    description:
      'Remove a participant from a live room (DELETE /api/v1/apps/{app}/rooms/{room}/participants/{identity}). Moderation action — use on user request.',
    group: 'rooms',
    annotations: DESTROY,
    inputSchema: {
      app: appParam(),
      room: z.string(),
      identity: z.string().describe('Participant identity to kick.'),
    },
    handler: (c, a) =>
      c.del(`/apps/${enc(a.app)}/rooms/${enc(a.room)}/participants/${enc(a.identity)}`),
  },
  {
    name: 'mute_participant',
    title: 'Mute/unmute participant',
    description:
      "Server-side mute/unmute of a participant's published tracks (POST /api/v1/apps/{app}/rooms/{room}/participants/{identity}/mute). Pass trackSid, or kind audio|video|all.",
    group: 'rooms',
    inputSchema: {
      app: appParam(),
      room: z.string(),
      identity: z.string(),
      trackSid: z.string().optional().describe('Specific track sid; omit to select by kind.'),
      kind: z.enum(['audio', 'video', 'all']).optional().describe('Tracks to affect (default all).'),
      muted: z.boolean().optional().describe('true = mute (default), false = unmute.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/rooms/${enc(a.room)}/participants/${enc(a.identity)}/mute`,
        defined({ trackSid: a.trackSid, kind: a.kind, muted: a.muted }),
      ),
  },
  {
    name: 'update_room_metadata',
    title: 'Update room metadata',
    description:
      "Set a live room's metadata; connected clients receive roomMetadataChanged (PATCH /api/v1/apps/{app}/rooms/{room}/metadata).",
    group: 'rooms',
    inputSchema: {
      app: appParam(),
      room: z.string(),
      metadata: z.string().describe('Opaque metadata string (typically JSON).'),
    },
    handler: (c, a) =>
      c.patch(`/apps/${enc(a.app)}/rooms/${enc(a.room)}/metadata`, { metadata: a.metadata }),
  },
  {
    name: 'send_room_data',
    title: 'Send data message to room',
    description:
      'Push a server-side data message (chat/reaction/custom) to every subscriber of a room (POST /api/v1/apps/{app}/rooms/{room}/data).',
    group: 'rooms',
    inputSchema: {
      app: appParam(),
      room: z.string(),
      topic: z.string().describe('Data topic; "chat"/"reaction" map to the chat/reaction callbacks.'),
      message: z.string().optional().describe('Convenience text message (chat).'),
      reaction: z.string().optional().describe('Reaction emoji/identifier for topic=reaction.'),
      payload: z.string().optional().describe('Raw payload; when omitted an envelope is built.'),
      from: z.string().optional().describe('Sender identity.'),
      destinationIdentities: z
        .array(z.string())
        .optional()
        .describe('Restrict delivery to these identities.'),
      reliable: z.boolean().optional().describe('Reliable delivery (default true).'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/rooms/${enc(a.room)}/data`,
        defined({
          topic: a.topic,
          message: a.message,
          reaction: a.reaction,
          payload: a.payload,
          from: a.from,
          destinationIdentities: a.destinationIdentities,
          reliable: a.reliable,
        }),
      ),
  },

  // ── Tags (dynamic stream/room tagging) ────────────────────────────────────
  {
    name: 'list_tags',
    title: 'List tags',
    description:
      "List the app's tags — small operator-created entities with a settings blob, applied to streams/rooms (GET /api/v1/apps/{app}/tags). Optional kind filter.",
    group: 'tags',
    annotations: READ,
    inputSchema: { app: appParam(), kind: z.string().optional().describe('Filter by kind (e.g. "store"/"zone"/"custom").') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/tags`, { query: { kind: a.kind } }),
  },
  {
    name: 'get_tag',
    title: 'Get tag',
    description: 'One tag by slug (GET /api/v1/apps/{app}/tags/{slug}). 404 if absent.',
    group: 'tags',
    annotations: READ,
    inputSchema: { app: appParam(), slug: z.string().describe('Tag slug.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/tags/${enc(a.slug)}`),
  },
  {
    name: 'create_tag',
    title: 'Create tag',
    description:
      'Create a tag entity — a settings blob consumers (e.g. Vision Edge) read per-model config from (POST /api/v1/apps/{app}/tags). 409 on a duplicate slug, 400 on a malformed slug.',
    group: 'tags',
    inputSchema: {
      app: appParam(),
      slug: z.string().describe('Stable kebab-case reference stored on streams, e.g. "store-downtown".'),
      label: z.string().describe('Human-readable label.'),
      kind: z.string().optional().describe('Tag kind, e.g. "store"/"zone"/"custom" (default "custom").'),
      config_json: z.record(z.any()).optional().describe("Settings blob owned by the tag's consumer."),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/tags`,
        defined({ slug: a.slug, label: a.label, kind: a.kind, config_json: a.config_json }),
      ),
  },
  {
    name: 'update_tag',
    title: 'Update tag',
    description:
      'Update a tag\'s label/kind/config_json — slug is immutable (PATCH /api/v1/apps/{app}/tags/{slug}).',
    group: 'tags',
    inputSchema: {
      app: appParam(),
      slug: z.string().describe('Tag slug.'),
      label: z.string().optional(),
      kind: z.string().optional(),
      config_json: z.record(z.any()).optional().describe('Replaces the stored settings blob.'),
    },
    handler: (c, a) =>
      c.patch(
        `/apps/${enc(a.app)}/tags/${enc(a.slug)}`,
        defined({ label: a.label, kind: a.kind, config_json: a.config_json }),
      ),
  },
  {
    name: 'delete_tag',
    title: 'Delete tag',
    description:
      "Delete a tag and prune its slug from every stream that referenced it, in one transaction (DELETE /api/v1/apps/{app}/tags/{slug}).",
    group: 'tags',
    annotations: DESTROY,
    inputSchema: { app: appParam(), slug: z.string().describe('Tag slug.') },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/tags/${enc(a.slug)}`),
  },
  {
    name: 'apply_room_tags',
    title: 'Apply tags to a room',
    description:
      "Replace the tag slugs applied to every stream row of a room (PATCH /api/v1/apps/{app}/tags/room/{room}). Every slug must reference an existing tag (400 otherwise).",
    group: 'tags',
    inputSchema: {
      app: appParam(),
      room: z.string().describe('Room name.'),
      tags: z.array(z.string()).describe('Tag slugs to apply (must all exist).'),
    },
    handler: (c, a) => c.patch(`/apps/${enc(a.app)}/tags/room/${enc(a.room)}`, { tags: a.tags }),
  },
  {
    name: 'get_stream_tags',
    title: 'Get stream tags',
    description: "A stream's applied tag slugs (GET /api/v1/apps/{app}/streams/{id}/tags).",
    group: 'tags',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Stream id (may contain "/").') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/streams/${enc(a.id)}/tags`),
  },
  {
    name: 'update_stream_tags',
    title: 'Set stream tags',
    description:
      "Replace a stream's applied tag slugs — every slug must reference an existing tag, 400 otherwise (PATCH /api/v1/apps/{app}/streams/{id}/tags).",
    group: 'tags',
    inputSchema: {
      app: appParam(),
      id: z.string().describe('Stream id (may contain "/").'),
      tags: z.array(z.string()).describe('Tag slugs to apply (must all exist).'),
    },
    handler: (c, a) => c.patch(`/apps/${enc(a.app)}/streams/${enc(a.id)}/tags`, { tags: a.tags }),
  },

  // ── Ingress (RTMP / WHIP / URL pull / SRT passthrough / MPEG-TS multicast) ─
  {
    name: 'create_ingress',
    title: 'Create ingress (get RTMP URL + key)',
    description:
      'Create an ingress for an app room (POST /api/v1/apps/{app}/ingress). inputType "rtmp" returns the RTMP push URL + stream key for OBS/encoders (optionally a failover pair with backup:true); "whip" returns a WHIP endpoint; "url" pulls a remote RTSP/HLS/MP4/SRT source into the room; "srt" is a PUSH passthrough endpoint (mode must be "passthrough") returning srt_url; "mpegts" is a PULL passthrough of a UDP unicast/multicast MPEG-TS source (mode must be "passthrough", url like "udp://@GROUP:PORT").',
    group: 'ingress',
    inputSchema: {
      app: appParam(),
      inputType: z
        .enum(['rtmp', 'whip', 'url', 'srt', 'mpegts'])
        .describe(
          'rtmp = push URL+key; whip = WHIP endpoint; url = pull a remote source; srt = SRT push passthrough; mpegts = UDP unicast/multicast MPEG-TS pull passthrough.',
        ),
      mode: z
        .enum(['transcode', 'passthrough'])
        .optional()
        .describe('REQUIRED "passthrough" for inputType srt/mpegts (LiveKit has no native input for either).'),
      room: z
        .string()
        .optional()
        .describe('Destination room (namespaced under the app prefix if not already).'),
      participantIdentity: z.string().optional().describe('Publisher identity (default generated).'),
      participantName: z.string().optional().describe('Publisher display name.'),
      url: z
        .string()
        .optional()
        .describe(
          'Required for inputType "url" (remote RTSP/HLS/MP4/SRT source) or "mpegts" (udp://@GROUP:PORT — group must be 224.0.0.0/4 for multicast).',
        ),
      sources: z
        .string()
        .optional()
        .describe('mpegts only: comma-separated source-IP allow-list for SSM/IGMPv3 multicast.'),
      localaddr: z.string().optional().describe('mpegts only: local NIC IPv4 to bind/join the multicast group on.'),
      fifoSize: z
        .number()
        .int()
        .optional()
        .describe('mpegts only: ffmpeg fifo_size in 188-byte packet units (default 28672).'),
      overrunNonfatal: z
        .boolean()
        .optional()
        .describe('mpegts only: survive a UDP buffer overrun instead of aborting (default true).'),
      enableTranscoding: z
        .boolean()
        .optional()
        .describe('Server-side multi-layer transcoding (defaults from app config).'),
      backup: z
        .boolean()
        .optional()
        .describe('rtmp only: also mint a second failover stream key bound to the same room.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/ingress`,
        defined({
          inputType: a.inputType,
          mode: a.mode,
          room: a.room,
          participantIdentity: a.participantIdentity,
          participantName: a.participantName,
          url: a.url,
          sources: a.sources,
          localaddr: a.localaddr,
          fifoSize: a.fifoSize,
          overrunNonfatal: a.overrunNonfatal,
          enableTranscoding: a.enableTranscoding,
          backup: a.backup,
        }),
      ),
  },
  {
    name: 'list_ingress',
    title: 'List ingresses',
    description:
      'Paginated list of the app ingresses with live state (status/bitrate/viewers) AND the ingest credentials rtmp_url + stream_key (GET /api/v1/apps/{app}/ingress).',
    group: 'ingress',
    annotations: READ,
    inputSchema: {
      app: appParam(),
      room: z.string().optional().describe('Filter by room.'),
      q: z.string().optional().describe('Substring filter over id/name/room.'),
      limit: z.number().int().positive().optional().describe('Page size (1..500, default 50).'),
      offset: z.number().int().min(0).optional(),
    },
    handler: (c, a) =>
      c.get(`/apps/${enc(a.app)}/ingress`, {
        query: { room: a.room, q: a.q, limit: a.limit, offset: a.offset },
      }),
  },
  {
    name: 'get_ingress',
    title: 'Get ingress',
    description: 'One ingress by id, with credentials and state (GET /api/v1/apps/{app}/ingress/{id}).',
    group: 'ingress',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Ingress id.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/ingress/${enc(a.id)}`),
  },
  {
    name: 'delete_ingress',
    title: 'Delete ingress',
    description:
      'Delete an ingress endpoint — its stream key stops working immediately (DELETE /api/v1/apps/{app}/ingress/{id}).',
    group: 'ingress',
    annotations: DESTROY,
    inputSchema: { app: appParam(), id: z.string() },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/ingress/${enc(a.id)}`),
  },

  // ── Recording ─────────────────────────────────────────────────────────────
  {
    name: 'start_recording',
    title: 'Start recording (room)',
    description:
      'Start a recording egress for a room (POST /api/v1/apps/{app}/recording/start). recordMode: composite (default, room render) | track (one publisher, no Chrome) | audio (audio-only).',
    group: 'recording',
    inputSchema: {
      app: appParam(),
      roomName: z.string().describe('LiveKit room to record.'),
      streamId: z
        .string()
        .optional()
        .describe('Logical stream id; in track/audio modes doubles as the participant identity.'),
      recordMode: z.enum(['composite', 'track', 'audio']).optional(),
      participantIdentity: z
        .string()
        .optional()
        .describe('Publisher identity for track/audio modes (defaults to streamId).'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/recording/start`,
        defined({
          roomName: a.roomName,
          streamId: a.streamId,
          recordMode: a.recordMode,
          participantIdentity: a.participantIdentity,
        }),
      ),
  },
  {
    name: 'stop_recording',
    title: 'Stop recording',
    description:
      'Stop an in-progress recording by its egress/recording id (POST /api/v1/apps/{app}/recording/{id}/stop).',
    group: 'recording',
    inputSchema: { app: appParam(), id: z.string().describe('Recording/egress id returned by start_recording.') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/recording/${enc(a.id)}/stop`),
  },
  {
    name: 'start_stream_recording',
    title: 'Start recording (live stream)',
    description:
      'Start recording an already-live stream by its stream id (POST /api/v1/apps/{app}/streams/{id}/record/start).',
    group: 'recording',
    inputSchema: {
      app: appParam(),
      id: z.string().describe('Stream id (may contain "/").'),
      recordMode: z.enum(['composite', 'track', 'audio']).optional(),
      participantIdentity: z.string().optional(),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/streams/${enc(a.id)}/record/start`,
        defined({ recordMode: a.recordMode, participantIdentity: a.participantIdentity }),
      ),
  },
  {
    name: 'stop_stream_recording',
    title: 'Stop recording (live stream)',
    description:
      'Stop the in-progress recording of a live stream (POST /api/v1/apps/{app}/streams/{id}/record/stop).',
    group: 'recording',
    inputSchema: { app: appParam(), id: z.string().describe('Stream id (may contain "/").') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/streams/${enc(a.id)}/record/stop`),
  },

  // ── VODs ──────────────────────────────────────────────────────────────────
  {
    name: 'list_vods',
    title: 'List VODs',
    description:
      'List the app VODs with filters, ordering and paging (GET /api/v1/apps/{app}/vods).',
    group: 'vods',
    annotations: READ,
    inputSchema: {
      app: appParam(),
      room: z.string().optional().describe('Filter by room.'),
      status: z.enum(['recording', 'uploading', 'ready', 'failed']).optional(),
      since: z.string().optional().describe('started_at lower bound (ISO).'),
      until: z.string().optional().describe('started_at upper bound (ISO).'),
      order: z.enum(['started_at', 'size_bytes', 'id']).optional(),
      dir: z.enum(['asc', 'desc']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    },
    handler: (c, a) =>
      c.get(`/apps/${enc(a.app)}/vods`, {
        query: {
          room: a.room,
          status: a.status,
          since: a.since,
          until: a.until,
          order: a.order,
          dir: a.dir,
          limit: a.limit,
          offset: a.offset,
        },
      }),
  },
  {
    name: 'get_vod',
    title: 'Get VOD',
    description:
      'VOD detail with playback URLs (url/presignedUrl/publicUrl) plus adaptive/HLS variants when available (GET /api/v1/apps/{app}/vods/{id}).',
    group: 'vods',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.number().int().describe('VOD id (number).') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/vods/${a.id}`),
  },
  {
    name: 'transcribe_vod',
    title: 'Transcribe VOD',
    description:
      'Trigger (or re-run) speech-to-text transcription of a ready VOD; requires the "transcription" plugin installed + enabled. Asynchronous — poll get_vod_transcript for status (POST /api/v1/apps/{app}/vods/{id}/transcribe).',
    group: 'vods',
    inputSchema: { app: appParam(), id: z.number().int().describe('VOD id (number).') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/vods/${a.id}/transcribe`),
  },
  {
    name: 'get_vod_transcript',
    title: 'Get VOD transcript',
    description:
      "A VOD's transcript: status (queued|processing|ready|failed), full text, timed segments with speakers, and the SRT subtitle (srtKey + presigned srtUrl) (GET /api/v1/apps/{app}/vods/{id}/transcript). 404 if never transcribed.",
    group: 'vods',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.number().int().describe('VOD id (number).') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/vods/${a.id}/transcript`),
  },
  {
    name: 'delete_vod',
    title: 'Delete VOD (DESTRUCTIVE)',
    description:
      'Permanently delete a VOD with full cascade: DB row + S3 object + snapshot + local file (DELETE /api/v1/apps/{app}/vods/{id}). DESTRUCTIVE — requires explicit user confirmation.',
    group: 'vods',
    destructive: true,
    annotations: DESTROY,
    inputSchema: { app: appParam(), id: z.number().int(), confirm: confirmParam() },
    handler: (c, a) => {
      requireConfirm(a);
      return c.del(`/apps/${enc(a.app)}/vods/${a.id}`);
    },
  },

  // ── Plugins ───────────────────────────────────────────────────────────────
  {
    name: 'list_plugins',
    title: 'List plugins (marketplace)',
    description:
      "Marketplace view: every built-in plugin plus this app's install/enable/config state (GET /api/v1/apps/{app}/plugins).",
    group: 'plugins',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins`),
  },
  {
    name: 'get_plugin',
    title: 'Get plugin',
    description:
      'One marketplace entry: manifest, configSchema and install state (GET /api/v1/apps/{app}/plugins/{id}).',
    group: 'plugins',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Plugin id, e.g. "yolo".') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/${enc(a.id)}`),
  },
  {
    name: 'install_plugin',
    title: 'Install plugin',
    description:
      'Install a built-in plugin into the app; idempotent (POST /api/v1/apps/{app}/plugins/{id}/install).',
    group: 'plugins',
    inputSchema: { app: appParam(), id: z.string() },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/plugins/${enc(a.id)}/install`),
  },
  {
    name: 'configure_plugin',
    title: 'Enable/disable/configure plugin',
    description:
      'Enable/disable an installed plugin and/or patch its config; config keys are validated against the plugin configSchema (PATCH /api/v1/apps/{app}/plugins/{id}).',
    group: 'plugins',
    inputSchema: {
      app: appParam(),
      id: z.string(),
      enabled: z.boolean().optional().describe('Enable/disable the installed plugin.'),
      config: z.record(z.any()).optional().describe('Partial config patch (schema-validated).'),
    },
    handler: (c, a) =>
      c.patch(
        `/apps/${enc(a.app)}/plugins/${enc(a.id)}`,
        defined({ enabled: a.enabled, config: a.config }),
      ),
  },
  {
    name: 'uninstall_plugin',
    title: 'Uninstall plugin',
    description:
      'Uninstall a plugin from the app — stops its worker and clears live-data feeds; its config is lost (DELETE /api/v1/apps/{app}/plugins/{id}).',
    group: 'plugins',
    annotations: DESTROY,
    inputSchema: { app: appParam(), id: z.string() },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/plugins/${enc(a.id)}`),
  },
  {
    name: 'control_plugin_worker',
    title: 'Plugin worker control',
    description:
      'Start/stop/inspect the worker process of a needsWorker plugin (POST /api/v1/apps/{app}/plugins/{id}/worker/start | /worker/stop, GET /worker/status).',
    group: 'plugins',
    inputSchema: {
      app: appParam(),
      id: z.string(),
      action: z.enum(['start', 'stop', 'status']).describe('What to do with the worker.'),
    },
    handler: (c, a) => {
      const base = `/apps/${enc(a.app)}/plugins/${enc(a.id)}/worker`;
      if (a.action === 'status') return c.get(`${base}/status`);
      return c.post(`${base}/${a.action}`);
    },
  },
  {
    name: 'get_plugin_logs',
    title: 'Plugin logs',
    description:
      'Per-plugin logs: worker output + persisted plugin log lines (GET /api/v1/apps/{app}/plugins/{id}/logs).',
    group: 'plugins',
    annotations: READ,
    inputSchema: {
      app: appParam(),
      id: z.string(),
      limit: z.number().int().positive().optional(),
    },
    handler: (c, a) =>
      c.get(`/apps/${enc(a.app)}/plugins/${enc(a.id)}/logs`, { query: { limit: a.limit } }),
  },

  // ── Live Control (pause/resume/finish a live stream with a cover) ─────────
  {
    name: 'list_live_control_streams',
    title: 'List live-control streams',
    description:
      'Live streams of the app with their pause/resume/finish control state (GET /api/v1/apps/{app}/plugins/live-control/streams).',
    group: 'live-control',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/live-control/streams`),
  },
  {
    name: 'get_live_control_stream',
    title: 'Get live-control state',
    description:
      'One stream and its control state (state/since/cover) (GET /api/v1/apps/{app}/plugins/live-control/streams/{streamId}).',
    group: 'live-control',
    annotations: READ,
    inputSchema: { app: appParam(), streamId: z.string().describe('Stream id.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/live-control/streams/${enc(a.streamId)}`),
  },
  {
    name: 'pause_live_stream',
    title: 'Pause live stream',
    description:
      'Pause a live stream: viewers see a cover (image/video/text card), audio muted server-side. Interrupts what viewers see — use only when the user asked for it (POST /api/v1/apps/{app}/plugins/live-control/streams/{streamId}/pause). Fires livecontrol.paused.',
    group: 'live-control',
    annotations: DESTROY,
    inputSchema: {
      app: appParam(),
      streamId: z.string().describe('Stream id.'),
      mode: z.enum(['image', 'video', 'text']).optional().describe('Cover type override.'),
      assetId: z.number().int().optional().describe('Uploaded cover asset id override.'),
      cardTitle: z.string().optional().describe('Text-card title override.'),
      cardText: z.string().optional().describe('Text-card body override.'),
      cardColor: z.string().optional().describe('Text-card color override, e.g. "#RRGGBB".'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/plugins/live-control/streams/${enc(a.streamId)}/pause`,
        defined({
          mode: a.mode,
          assetId: a.assetId,
          cardTitle: a.cardTitle,
          cardText: a.cardText,
          cardColor: a.cardColor,
        }),
      ),
  },
  {
    name: 'resume_live_stream',
    title: 'Resume live stream',
    description:
      'Resume a paused live stream — unmutes and clears the cover (POST /api/v1/apps/{app}/plugins/live-control/streams/{streamId}/resume). Fires livecontrol.resumed.',
    group: 'live-control',
    inputSchema: { app: appParam(), streamId: z.string().describe('Stream id.') },
    handler: (c, a) => c.post(`/apps/${enc(a.app)}/plugins/live-control/streams/${enc(a.streamId)}/resume`),
  },
  {
    name: 'finish_live_stream',
    title: 'Finish live stream (with cover)',
    description:
      'Finish a live stream showing a final card/asset cover — a stronger, terminal version of pause. Use only when the user asked for it (POST /api/v1/apps/{app}/plugins/live-control/streams/{streamId}/finish). Fires livecontrol.finished.',
    group: 'live-control',
    annotations: DESTROY,
    inputSchema: {
      app: appParam(),
      streamId: z.string().describe('Stream id.'),
      mode: z.enum(['image', 'video', 'text']).optional().describe('Cover type override.'),
      assetId: z.number().int().optional().describe('Uploaded cover asset id override.'),
      cardTitle: z.string().optional().describe('Text-card title override.'),
      cardText: z.string().optional().describe('Text-card body override.'),
      cardColor: z.string().optional().describe('Text-card color override, e.g. "#RRGGBB".'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/plugins/live-control/streams/${enc(a.streamId)}/finish`,
        defined({
          mode: a.mode,
          assetId: a.assetId,
          cardTitle: a.cardTitle,
          cardText: a.cardText,
          cardColor: a.cardColor,
        }),
      ),
  },
  {
    name: 'list_live_control_assets',
    title: 'List live-control cover assets',
    description:
      'Uploaded cover assets (images/videos) with signed preview URLs (GET /api/v1/apps/{app}/plugins/live-control/assets). Uploading a new asset is a multipart file upload, not exposed over MCP — use the dashboard.',
    group: 'live-control',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/live-control/assets`),
  },
  {
    name: 'get_live_control_asset_url',
    title: 'Get live-control asset URL',
    description: 'A fresh signed preview URL for one cover asset (GET /api/v1/apps/{app}/plugins/live-control/assets/{id}/url).',
    group: 'live-control',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.number().int().describe('Asset id.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/live-control/assets/${a.id}/url`),
  },
  {
    name: 'delete_live_control_asset',
    title: 'Delete live-control asset',
    description: 'Delete a cover asset — DB row + S3 object (DELETE /api/v1/apps/{app}/plugins/live-control/assets/{id}).',
    group: 'live-control',
    annotations: DESTROY,
    inputSchema: { app: appParam(), id: z.number().int().describe('Asset id.') },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/plugins/live-control/assets/${a.id}`),
  },
  {
    name: 'get_live_control_settings',
    title: 'Get live-control settings',
    description:
      "The app's live-control defaults: default cover mode/card, mute-on-pause, poll interval, default pause/finish asset ids (GET /api/v1/apps/{app}/plugins/live-control/settings).",
    group: 'live-control',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/live-control/settings`),
  },
  {
    name: 'set_live_control_settings',
    title: 'Set live-control default assets',
    description:
      'Set the default pause/finish cover assets used when a call omits an override; pass null to clear (PUT /api/v1/apps/{app}/plugins/live-control/settings).',
    group: 'live-control',
    inputSchema: {
      app: appParam(),
      defaultPauseAssetId: z.number().int().nullable().optional().describe('Default pause cover asset id, or null to clear.'),
      defaultFinishAssetId: z.number().int().nullable().optional().describe('Default finish cover asset id, or null to clear.'),
    },
    handler: (c, a) =>
      c.put(
        `/apps/${enc(a.app)}/plugins/live-control/settings`,
        defined({ defaultPauseAssetId: a.defaultPauseAssetId, defaultFinishAssetId: a.defaultFinishAssetId }),
      ),
  },

  // ── Stream Health (origin quality monitor) ────────────────────────────────
  {
    name: 'get_stream_health_overview',
    title: 'Stream health overview',
    description:
      "Health events today + rooms with recent history/threshold overrides (GET /api/v1/apps/{app}/plugins/stream-health/overview).",
    group: 'stream-health',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/stream-health/overview`),
  },
  {
    name: 'list_stream_health_events',
    title: 'List stream health events',
    description:
      'Recent health.* transitions (e.g. audio_lost, av_desync, stalled, degraded, recovered) from stream-health.db (GET /api/v1/apps/{app}/plugins/stream-health/events).',
    group: 'stream-health',
    annotations: READ,
    inputSchema: {
      app: appParam(),
      room: z.string().optional().describe('Restrict to one room.'),
      limit: z.number().int().positive().optional().describe('Default 50, max 1000.'),
    },
    handler: (c, a) =>
      c.get(`/apps/${enc(a.app)}/plugins/stream-health/events`, { query: { room: a.room, limit: a.limit } }),
  },
  {
    name: 'get_stream_health_room_settings',
    title: 'Get per-room health thresholds',
    description:
      "A room's threshold override plus the resolved effective thresholds (defaults ⊕ install config ⊕ override) (GET /api/v1/apps/{app}/plugins/stream-health/streams/{room}/settings).",
    group: 'stream-health',
    annotations: READ,
    inputSchema: { app: appParam(), room: z.string().describe('Room / stream name.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/stream-health/streams/${enc(a.room)}/settings`),
  },
  {
    name: 'set_stream_health_room_settings',
    title: 'Set per-room health thresholds',
    description:
      'Set a PARTIAL per-room threshold override — only pass the fields you want to change; omit a field to keep its current value/default, pass no fields at all to clear the override entirely. Picked up live by the worker, no restart (PUT /api/v1/apps/{app}/plugins/stream-health/streams/{room}/settings).',
    group: 'stream-health',
    inputSchema: {
      app: appParam(),
      room: z.string().describe('Room / stream name.'),
      sample_interval_sec: z.number().min(2).max(300).optional().describe('Probe cadence in seconds (default 10).'),
      silence_db: z.number().min(-120).max(0).optional().describe('Mean dBFS counted as silent (default -50).'),
      silence_duration_sec: z
        .number()
        .min(1)
        .max(600)
        .optional()
        .describe('Continuous silence (s) before health.audio_lost (default 15).'),
      desync_ms: z.number().min(10).max(10000).optional().describe('|audio-video| drift (ms) before health.av_desync (default 200).'),
      stall_sec: z.number().min(2).max(600).optional().describe('No playlist progress (s) before health.stalled (default 20).'),
      bitrate_drop_pct: z
        .number()
        .min(0)
        .max(95)
        .optional()
        .describe('% below rolling baseline counted as degraded; 0 = off (default 50).'),
      recover_samples: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe('Consecutive clean samples required before health.recovered (default 2).'),
    },
    handler: (c, a) =>
      c.put(`/apps/${enc(a.app)}/plugins/stream-health/streams/${enc(a.room)}/settings`, {
        config: defined({
          sample_interval_sec: a.sample_interval_sec,
          silence_db: a.silence_db,
          silence_duration_sec: a.silence_duration_sec,
          desync_ms: a.desync_ms,
          stall_sec: a.stall_sec,
          bitrate_drop_pct: a.bitrate_drop_pct,
          recover_samples: a.recover_samples,
        }),
      }),
  },

  // ── Streamflow (visual event-driven automation workflows) ────────────────
  {
    name: 'list_streamflow_events',
    title: 'Streamflow event catalogue',
    description:
      'The catalogue of known trigger events by family (room/stream/plugin/etc.), for building workflow triggers (GET /api/v1/apps/{app}/plugins/streamflow/events).',
    group: 'streamflow',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/streamflow/events`),
  },
  {
    name: 'list_workflows',
    title: 'List Streamflow workflows',
    description: "The app's Streamflow automation workflows (GET /api/v1/apps/{app}/plugins/streamflow/workflows).",
    group: 'streamflow',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/streamflow/workflows`),
  },
  {
    name: 'get_workflow',
    title: 'Get Streamflow workflow',
    description: 'One workflow with its graph (GET /api/v1/apps/{app}/plugins/streamflow/workflows/{id}).',
    group: 'streamflow',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Workflow id.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/streamflow/workflows/${enc(a.id)}`),
  },
  {
    name: 'create_workflow',
    title: 'Create Streamflow workflow',
    description:
      'Create an automation workflow: a graph of trigger/condition/action boxes (POST /api/v1/apps/{app}/plugins/streamflow/workflows). Use list_streamflow_events for trigger names and the dashboard box palette for box types — graph shape is { boxes:[{id,type,config}], edges:[{from,fromPort?,to}] }.',
    group: 'streamflow',
    inputSchema: {
      app: appParam(),
      name: z.string().describe('Workflow name.'),
      enabled: z.boolean().optional().describe('Whether triggers are active (default true).'),
      graph: z.record(z.any()).optional().describe('{ boxes:[{id,type,config}], edges:[{from,fromPort?,to}] }.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/plugins/streamflow/workflows`,
        defined({ name: a.name, enabled: a.enabled, graph: a.graph }),
      ),
  },
  {
    name: 'update_workflow',
    title: 'Update Streamflow workflow',
    description: 'Update a workflow\'s name/enabled/graph (PUT /api/v1/apps/{app}/plugins/streamflow/workflows/{id}).',
    group: 'streamflow',
    inputSchema: {
      app: appParam(),
      id: z.string().describe('Workflow id.'),
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      graph: z.record(z.any()).optional().describe('Replacement graph.'),
    },
    handler: (c, a) =>
      c.put(
        `/apps/${enc(a.app)}/plugins/streamflow/workflows/${enc(a.id)}`,
        defined({ name: a.name, enabled: a.enabled, graph: a.graph }),
      ),
  },
  {
    name: 'delete_workflow',
    title: 'Delete Streamflow workflow',
    description:
      'Delete a workflow and its run history (DELETE /api/v1/apps/{app}/plugins/streamflow/workflows/{id}).',
    group: 'streamflow',
    annotations: DESTROY,
    inputSchema: { app: appParam(), id: z.string().describe('Workflow id.') },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/plugins/streamflow/workflows/${enc(a.id)}`),
  },
  {
    name: 'enable_workflow',
    title: 'Enable/disable Streamflow workflow',
    description: 'Enable or disable a workflow (POST /api/v1/apps/{app}/plugins/streamflow/workflows/{id}/enable).',
    group: 'streamflow',
    inputSchema: {
      app: appParam(),
      id: z.string().describe('Workflow id.'),
      enabled: z.boolean().describe('Enabled flag.'),
    },
    handler: (c, a) =>
      c.post(`/apps/${enc(a.app)}/plugins/streamflow/workflows/${enc(a.id)}/enable`, { enabled: a.enabled }),
  },
  {
    name: 'run_workflow',
    title: 'Run Streamflow workflow manually',
    description:
      'Trigger a manual run of a workflow with an optional payload injected as the trigger context (POST /api/v1/apps/{app}/plugins/streamflow/workflows/{id}/run).',
    group: 'streamflow',
    inputSchema: {
      app: appParam(),
      id: z.string().describe('Workflow id.'),
      payload: z.record(z.any()).optional().describe('Injected as context.trigger for this run.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/plugins/streamflow/workflows/${enc(a.id)}/run`,
        defined({ payload: a.payload }),
      ),
  },
  {
    name: 'export_workflow',
    title: 'Export Streamflow workflow',
    description:
      'Export a workflow as portable, secret-safe JSON ({ streamflow, name, graph, redactions? }) — config paths that looked like secrets are redacted, never exported with values (GET /api/v1/apps/{app}/plugins/streamflow/workflows/{id}/export).',
    group: 'streamflow',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Workflow id.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/streamflow/workflows/${enc(a.id)}/export`),
  },
  {
    name: 'import_workflow',
    title: 'Import Streamflow workflow',
    description:
      'Import a workflow from portable JSON (validated against the box catalogue; unknown box types are rejected) (POST /api/v1/apps/{app}/plugins/streamflow/workflows/import).',
    group: 'streamflow',
    inputSchema: {
      app: appParam(),
      workflow: z.record(z.any()).describe('Portable workflow JSON: { streamflow, name, graph }.'),
      name: z.string().optional().describe('Override the imported workflow name.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/plugins/streamflow/workflows/import`,
        defined({ workflow: a.workflow, name: a.name }),
      ),
  },
  {
    name: 'list_workflow_runs',
    title: 'List Streamflow runs',
    description:
      'Recent workflow runs, optionally filtered by workflow (GET /api/v1/apps/{app}/plugins/streamflow/runs).',
    group: 'streamflow',
    annotations: READ,
    inputSchema: {
      app: appParam(),
      workflowId: z.string().optional().describe('Restrict to one workflow.'),
      limit: z.number().int().positive().optional(),
    },
    handler: (c, a) =>
      c.get(`/apps/${enc(a.app)}/plugins/streamflow/runs`, { query: { workflowId: a.workflowId, limit: a.limit } }),
  },
  {
    name: 'get_workflow_run',
    title: 'Get Streamflow run',
    description: 'One run with its per-box steps (GET /api/v1/apps/{app}/plugins/streamflow/runs/{id}).',
    group: 'streamflow',
    annotations: READ,
    inputSchema: { app: appParam(), id: z.string().describe('Run id.') },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/streamflow/runs/${enc(a.id)}`),
  },
  {
    name: 'list_streamflow_secrets',
    title: 'List Streamflow secrets (masked)',
    description:
      'Secret NAMES + a masked hint (e.g. "sk-…a1b2") for this app\'s Streamflow secrets — values are NEVER returned by any endpoint (GET /api/v1/apps/{app}/plugins/streamflow/secrets).',
    group: 'streamflow',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/plugins/streamflow/secrets`),
  },
  {
    name: 'put_streamflow_secret',
    title: 'Create/replace Streamflow secret',
    description:
      'Create or replace a Streamflow secret value, encrypted at rest — referenced from workflow box configs as {{secret.NAME}}. The value is write-only: this call returns only masked metadata, never the value back (PUT /api/v1/apps/{app}/plugins/streamflow/secrets/{name}).',
    group: 'streamflow',
    inputSchema: {
      app: appParam(),
      name: z.string().describe('Secret name, UPPER_SNAKE_CASE (A-Z, 0-9, _), 1-64 chars.'),
      value: z.string().describe('Secret plaintext value to encrypt and store.'),
    },
    handler: (c, a) => c.put(`/apps/${enc(a.app)}/plugins/streamflow/secrets/${enc(a.name)}`, { value: a.value }),
  },
  {
    name: 'delete_streamflow_secret',
    title: 'Delete Streamflow secret',
    description: 'Delete a Streamflow secret by name (DELETE /api/v1/apps/{app}/plugins/streamflow/secrets/{name}).',
    group: 'streamflow',
    annotations: DESTROY,
    inputSchema: { app: appParam(), name: z.string().describe('Secret name.') },
    handler: (c, a) => c.del(`/apps/${enc(a.app)}/plugins/streamflow/secrets/${enc(a.name)}`),
  },

  // ── Tokens ────────────────────────────────────────────────────────────────
  {
    name: 'mint_join_token',
    title: 'Mint LiveKit join token',
    description:
      'Mint a LiveKit join token for an app room, returning the token plus public player/iframe URLs (POST /api/v1/apps/{app}/tokens). Use canPublish=false for viewer-only tokens.',
    group: 'tokens',
    inputSchema: {
      app: appParam(),
      room: z.string().optional().describe('Room (namespaced under the app prefix; defaults to it).'),
      identity: z.string().optional().describe('Participant identity (default random).'),
      name: z.string().optional().describe('Display name.'),
      canPublish: z.boolean().optional().describe('Allow publishing (default true).'),
      canSubscribe: z.boolean().optional().describe('Allow subscribing (default true).'),
      ttl: z.string().optional().describe('Token TTL, e.g. "10m" (default "6h").'),
      metadata: z.string().optional().describe('Opaque participant metadata.'),
      hidden: z.boolean().optional().describe('Hidden participant (QC/recorder), not counted as viewer.'),
      recorder: z.boolean().optional().describe('Recorder/QC grant (roomRecord); pairs with hidden.'),
      audioOnly: z.boolean().optional().describe('Restrict publishing to microphone only.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/tokens`,
        defined({
          room: a.room,
          identity: a.identity,
          name: a.name,
          canPublish: a.canPublish,
          canSubscribe: a.canSubscribe,
          ttl: a.ttl,
          metadata: a.metadata,
          hidden: a.hidden,
          recorder: a.recorder,
          audioOnly: a.audioOnly,
        }),
      ),
  },
  {
    name: 'sign_playback_url',
    title: 'Sign playback URL / mint embed',
    description:
      'Mint a signed short-TTL playback capability for a room — required for apps with publicPlayback disabled (POST /api/v1/apps/{app}/play-token/{room}/sign). Default TTL 300s (30s-24h). Returns tokenUrl (raw API), playUrl (SPA player), embedUrl (SPA embed) and a ready-made iframe snippet — use embedUrl/iframe to embed the stream on a third-party page.',
    group: 'tokens',
    inputSchema: {
      app: appParam(),
      room: z.string(),
      ttlSeconds: z.number().int().min(30).max(86400).optional().describe('Lifetime in seconds.'),
    },
    handler: (c, a) =>
      c.post(
        `/apps/${enc(a.app)}/play-token/${enc(a.room)}/sign`,
        defined({ ttlSeconds: a.ttlSeconds }),
      ),
  },
  {
    name: 'list_api_tokens',
    title: 'List API tokens',
    description: 'List the sk_ API tokens visible to the caller — hashes never returned (GET /api/v1/tokens).',
    group: 'tokens',
    annotations: READ,
    inputSchema: {},
    handler: (c) => c.get('/tokens'),
  },
  {
    name: 'create_api_token',
    title: 'Create API token',
    description:
      'Create a new sk_ API token; the plaintext is returned ONCE — relay it to the user immediately (POST /api/v1/tokens). Prefer scope "app" over "global".',
    group: 'tokens',
    inputSchema: {
      name: z.string().describe('Label for the token, e.g. "mcp-agent".'),
      scope: z.enum(['global', 'app']).describe('Token scope; "app" requires appId.'),
      appId: z.number().int().optional().describe('Required when scope = "app".'),
      allowedIps: z.array(z.string()).optional().describe('Optional IP allowlist.'),
    },
    handler: (c, a) =>
      c.post(
        '/tokens',
        defined({ name: a.name, scope: a.scope, appId: a.appId, allowedIps: a.allowedIps }),
      ),
  },
  {
    name: 'revoke_api_token',
    title: 'Revoke API token',
    description:
      'Revoke (soft-delete) an sk_ API token by id — integrations using it stop working (DELETE /api/v1/tokens/{id}).',
    group: 'tokens',
    annotations: DESTROY,
    inputSchema: { id: z.number().int().describe('Token id from list_api_tokens.') },
    handler: (c, a) => c.del(`/tokens/${a.id}`),
  },

  // ── DB maintenance ────────────────────────────────────────────────────────
  {
    name: 'get_app_db_health',
    title: 'App DB health',
    description:
      'Health of the per-app SQLite DB: size, WAL, fragmentation, per-table rows (GET /api/v1/apps/{app}/db/health).',
    group: 'maintenance',
    annotations: READ,
    inputSchema: { app: appParam() },
    handler: (c, a) => c.get(`/apps/${enc(a.app)}/db/health`),
  },
  {
    name: 'purge_app_db',
    title: 'Purge app data (DESTRUCTIVE)',
    description:
      "Purge app data by scope: 'vods' (cascades to S3 + local files), 'logs', or 'all' app-scoped data — the app and its config survive (POST /api/v1/apps/{app}/db/purge). DESTRUCTIVE — requires explicit user confirmation.",
    group: 'maintenance',
    destructive: true,
    annotations: DESTROY,
    inputSchema: {
      app: appParam(),
      scope: z.enum(['vods', 'logs', 'all']).describe('What to purge.'),
      confirm: confirmParam(),
    },
    handler: (c, a) => {
      requireConfirm(a);
      return c.post(`/apps/${enc(a.app)}/db/purge`, { scope: a.scope, confirm: true });
    },
  },
];

/** The tool set actually registered, honoring the destructive gate. */
export function buildTools(opts: { allowDestructive: boolean }): ToolDef[] {
  return opts.allowDestructive ? TOOLS : TOOLS.filter((t) => !t.destructive);
}
