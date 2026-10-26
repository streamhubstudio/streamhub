/**
 * GENERIC edge spawn resolver — the edge.protocol seam implementation.
 *
 * Registers itself as the active {@link SpawnResolver} on module init so the
 * gateway/scheduler's `toAssignFrame` produces a REAL spawn spec for ANY
 * edge-assignable plugin — with NO per-plugin special-casing:
 *
 *   1. resolve the plugin's own `worker.spawn(ctx)` against a REMOTE ctx
 *      (originUrl = the origin public base — a remote edge cannot use loopback),
 *      exactly like the grid worker-hook does;
 *   2. inject the framework EDGE env every remote worker needs to feed results
 *      back: STREAMHUB_APP / STREAMHUB_PLUGIN_ID / STREAMHUB_INGEST_URL /
 *      STREAMHUB_EVENTS_URL (off the origin base) + a STABLE, cluster-derived
 *      ingest token (HMAC(cluster secret, `${app}:${pluginId}:${room}`)) — same
 *      for the same workload across re-offers, derivable server-side, and never
 *      putting the cluster secret on the wire. The plugin's own `spec.env` wins
 *      on conflict (a plugin may override deliberately), matching the worker-hook.
 *
 * SECRET HYGIENE: the resolver never reads or forwards plugin secrets; a
 * withheld-secret worker (e.g. the demography vision app) simply omits it from
 * its remote-branch env. The only secret in the frame is the derived ingest
 * token — a hex HMAC, never the raw cluster secret.
 */
import {
  Inject,
  Injectable,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';

import { ConfigService } from '../../shared/config/config.service';
import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { AppstoreService } from '../plugins/appstore/appstore.service';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { SpawnResolver, setSpawnResolver } from './edge.protocol';
import type { EdgeBundleRef, EdgeSpawnSpec } from './edge.types';

@Injectable()
export class GenericSpawnResolver
  implements SpawnResolver, OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly config: ConfigService,
    private readonly registry: PluginRegistryService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    // APP VERSIONING seam — optional so existing edge unit specs construct the
    // resolver with just (config, registry, apps). When present, a pinned
    // install attaches its bundle ref (id/version/sha256/url) to the assign
    // frame so the node fetches + verifies + runs the pinned version.
    @Optional() private readonly appstore?: AppstoreService,
    @Optional() private readonly appPlugins?: AppPluginsRepository,
  ) {}

  onModuleInit(): void {
    setSpawnResolver(this);
  }

  onModuleDestroy(): void {
    setSpawnResolver(null);
  }

  resolve(
    app: string,
    pluginId: string,
    config: Record<string, unknown>,
  ): EdgeSpawnSpec {
    const meta = this.registry.getMeta(pluginId);
    if (!meta?.worker) return { command: '', args: [], env: {} };

    let appDir = '';
    try {
      appDir = this.apps.appDir(app);
    } catch {
      appDir = '';
    }
    const originUrl = this.config.publicBaseUrl || undefined;
    const spec = meta.worker.spawn({
      app,
      config,
      appDir,
      dataDir: this.config.dataDir,
      livekitUrl: this.config.livekitUrl,
      originUrl,
    });

    const room = String(config.room ?? config.streamId ?? '');
    const base = (this.config.publicBaseUrl || '').replace(/\/+$/, '');
    const frameworkEnv: Record<string, string> = {
      STREAMHUB_APP: app,
      STREAMHUB_PLUGIN_ID: pluginId,
      // Stable, scoped, secret-free — the ONLY secret the frame carries.
      STREAMHUB_INGEST_TOKEN: this.ingestToken(app, pluginId, room),
    };
    if (base) {
      const pluginBase = `${base}/api/v1/apps/${encodeURIComponent(
        app,
      )}/plugins/${encodeURIComponent(pluginId)}`;
      frameworkEnv.STREAMHUB_INGEST_URL = `${pluginBase}/live`;
      frameworkEnv.STREAMHUB_EVENTS_URL = `${pluginBase}/events`;
    }

    return {
      command: spec.command,
      args: spec.args ?? [],
      // Framework env first so a plugin can still override deliberately.
      env: { ...frameworkEnv, ...(spec.env ?? {}) },
    };
  }

  /**
   * APP VERSIONING — the pinned bundle ref for an edge assignment's install, or
   * null when it runs the built-in/latest (or the appstore seam is absent). The
   * `url` is the master's bundle endpoint the node fetches over the cluster gate;
   * `sha256` lets the node verify the bytes before extract. Never throws.
   */
  resolveBundle(app: string, pluginId: string): EdgeBundleRef | null {
    if (!this.appstore || !this.appPlugins) return null;
    let version: string | null = null;
    try {
      version = this.appPlugins.get(app, pluginId)?.workerVersion ?? null;
    } catch {
      return null;
    }
    if (!version) return null;
    const sha256 = this.appstore.versionSha256(pluginId, version);
    if (!sha256) return null; // pinned version vanished from the store
    const base = (this.config.publicBaseUrl || '').replace(/\/+$/, '');
    const url = `${base}/api/v1/plugins/${encodeURIComponent(
      pluginId,
    )}/versions/${encodeURIComponent(version)}/bundle`;
    return { pluginId, version, sha256, url };
  }

  /**
   * A stable, scoped ingest token for an edge assignment: HMAC(cluster secret,
   * `${app}:${pluginId}:${room}`). Stable across re-offers (a reconnecting edge
   * keeps the same token) and derivable server-side for later verification,
   * without ever putting the cluster secret on the wire. Falls back to a random
   * per-process token when the cluster secret is unset (single-node dev).
   */
  private ingestToken(app: string, pluginId: string, room: string): string {
    const secret = this.config.clusterToken;
    if (!secret) return `${GenericSpawnResolver.ephemeral}:${randomUUID()}`;
    return createHmac('sha256', secret)
      .update(`${app}:${pluginId}:${room}`)
      .digest('hex');
  }

  private static readonly ephemeral = randomUUID().slice(0, 8);
}
