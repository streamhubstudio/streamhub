import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ModuleRef } from '@nestjs/core';
import { Request } from 'express';
import {
  EgressStatus,
  IngressInput,
  ParticipantInfo_Kind,
  type WebhookEvent,
} from '@livekit/protocol';

import { Public } from '../../shared/auth';
import {
  APPS_SERVICE,
  AppsServiceContract,
  CALLBACKS_SERVICE,
  CallbackEvent,
  CallbacksServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
  RECORDING_SERVICE,
  RecordingServiceContract,
  RESTREAM_SERVICE,
  RestreamServiceContract,
  STREAMS_SERVICE,
  StreamsServiceContract,
  StreamType,
} from '../../shared/contracts';
import { LiveKitService } from './livekit.service';
import { IngressAuthService } from './ingress-auth.service';

/**
 * LiveKit webhook sink (SPEC §5 livekit, §6). Public route — authenticity is
 * verified by the LiveKit signature in the Authorization header (WebhookReceiver),
 * not a Bearer token.
 *
 * Uses the raw request body (main.ts sets `rawBody: true`) so the signature is
 * checked against the exact bytes LiveKit signed. Cross-module services are
 * resolved lazily via ModuleRef (no DI import cycles); every dispatch is wrapped
 * so a downstream failure never crashes the process and never makes LiveKit
 * retry-storm — we always ack 200.
 */
@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly livekit: LiveKitService,
    private readonly ingressAuth: IngressAuthService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get logs(): LogsServiceContract | null {
    try {
      return this.moduleRef.get<LogsServiceContract>(LOGS_SERVICE, {
        strict: false,
      });
    } catch {
      return null;
    }
  }

  private resolve<T>(token: symbol): T | null {
    try {
      return this.moduleRef.get<T>(token, { strict: false });
    } catch {
      return null;
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.logs?.write(level, 'livekit-webhook', message, meta);
  }

  @Public()
  @Post('livekit')
  @HttpCode(200)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('authorization') auth: string,
  ): Promise<{ data: { received: boolean } }> {
    const body =
      req.rawBody?.toString('utf8') ??
      (typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {}));

    let event: WebhookEvent;
    try {
      event = (await this.livekit.receiveWebhook(body, auth || '')) as WebhookEvent;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('warn', `webhook signature rejected: ${message}`);
      throw new UnauthorizedException('invalid LiveKit webhook signature');
    }

    try {
      await this.handle(event);
    } catch (err) {
      // Never crash on processing errors — log and ack.
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `webhook handler error: ${message}`, {
        event: event?.event,
      });
    }
    return { data: { received: true } };
  }

  // ---------------------------------------------------------------------------
  // Event routing
  // ---------------------------------------------------------------------------

  private async handle(event: WebhookEvent): Promise<void> {
    const name = event.event;
    const roomName = event.room?.name ?? event.ingressInfo?.roomName ?? '';
    const app = await this.resolveApp(roomName);
    this.log('info', `event ${name}`, { room: roomName, app: app ?? undefined });

    // 1) Business routing (advances recording/stream state + business callbacks).
    switch (name) {
      case 'egress_started':
      case 'egress_updated':
      case 'egress_ended':
        await this.onEgress(event, app);
        break;
      case 'ingress_started':
      case 'ingress_updated':
        await this.onIngressStarted(event, app);
        break;
      case 'ingress_ended':
        await this.onIngressEnded(event, app);
        break;
      case 'track_published':
        // A stream = a participant publishing >=1 track. It is created/updated
        // HERE, not on participant_joined (a mere subscriber joining must never
        // become a stream — that was the over-count bug).
        await this.onTrackPublished(event, app);
        break;
      case 'track_unpublished':
        await this.onTrackUnpublished(event, app);
        break;
      case 'participant_left':
        await this.onParticipantLeft(event, app);
        break;
      default:
        // room_started/room_finished/participant_joined → no business handler.
        // participant_joined intentionally does NOT create a stream: a joined
        // participant with 0 published tracks is a subscriber/viewer, not a
        // stream. It is still forwarded verbatim to the app callback below.
        break;
    }

    // 2) Forward EVERY LiveKit webhook to the app callback (wave-3 §4). Skipped
    //    when no app could be resolved (callbacks must not fire app-less).
    await this.forwardRaw(app, name, roomName, event);
  }

  /**
   * Map a raw LiveKit webhook name to a CallbackEvent and dispatch it verbatim.
   * Only events in the wave-3 §4 taxonomy are forwarded; unknown/unmapped
   * LiveKit events (e.g. ingress_updated, track_muted) are ignored here.
   */
  private async forwardRaw(
    app: string | null,
    name: string,
    room: string,
    event: WebhookEvent,
  ): Promise<void> {
    if (!app) return;
    const FORWARDED: ReadonlySet<string> = new Set([
      'room_started',
      'room_finished',
      'participant_joined',
      'participant_left',
      'track_published',
      'track_unpublished',
      'ingress_started',
      'ingress_ended',
      'egress_started',
      'egress_updated',
      'egress_ended',
    ]);
    if (!FORWARDED.has(name)) return;
    await this.dispatch(app, name as CallbackEvent, this.buildEventData(room, event));
  }

  /** Build a flat, JSON-safe callback `data` payload from a LiveKit event. */
  private buildEventData(
    room: string,
    event: WebhookEvent,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { room };
    const p = event.participant;
    if (p) {
      data.participant = {
        identity: p.identity,
        name: p.name,
        sid: p.sid,
        hidden: Boolean(p.permission?.hidden),
      };
    }
    const t = event.track;
    if (t) {
      data.track = {
        sid: t.sid,
        type: String(t.type),
        source: String(t.source),
        muted: t.muted,
      };
    }
    const ing = event.ingressInfo;
    if (ing) {
      data.ingress = {
        ingressId: ing.ingressId,
        inputType: String(ing.inputType),
        roomName: ing.roomName,
      };
    }
    const eg = event.egressInfo;
    if (eg) {
      data.egress = {
        egressId: eg.egressId,
        status: String(eg.status),
        roomName: eg.roomName,
      };
    }
    if (event.id) data.eventId = event.id;
    if (event.createdAt) data.createdAt = Number(event.createdAt);
    return data;
  }

  /** Map a LiveKit room name back to a StreamHub app via the app room prefix. */
  private async resolveApp(roomName: string): Promise<string | null> {
    if (!roomName) return null;
    const apps = this.resolve<AppsServiceContract>(APPS_SERVICE);
    if (!apps) return null;
    try {
      const list = await apps.list();
      // Longest matching prefix wins.
      const match = list
        .filter(
          (a) =>
            roomName === a.livekitRoomPrefix ||
            roomName.startsWith(`${a.livekitRoomPrefix}-`),
        )
        .sort(
          (a, b) => b.livekitRoomPrefix.length - a.livekitRoomPrefix.length,
        )[0];
      return match?.name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Canonical stream key for a participant-backed stream. MUST match
   * StreamsService.canonicalStreamId — both the webhook path and reconcile()
   * derive `${room}/${identity}` so one publisher yields exactly one row.
   */
  private streamKey(room: string, identity: string): string {
    return `${room}/${identity}`;
  }

  private ingressType(input: IngressInput | undefined): StreamType {
    switch (input) {
      case IngressInput.WHIP_INPUT:
        return 'whip';
      case IngressInput.URL_INPUT:
        return 'rtsp';
      case IngressInput.RTMP_INPUT:
      default:
        return 'rtmp';
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private async onEgress(
    event: WebhookEvent,
    app: string | null,
  ): Promise<void> {
    const info = event.egressInfo;
    if (!info) return;
    const status = EgressStatus[info.status] ?? String(info.status);

    const recording = this.resolve<RecordingServiceContract>(RECORDING_SERVICE);
    if (!recording) {
      this.log('warn', 'recording service unavailable for egress event');
    } else {
      try {
        await recording.onEgressEvent(info.egressId, status, event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log('error', `recording.onEgressEvent failed: ${message}`, {
          egressId: info.egressId,
          status,
        });
      }
    }

    // Restream (multi-destination RTMP forwarding): advance per-endpoint state.
    // Non-restream egresses simply don't match a target row → no-op there.
    const restream = this.resolve<RestreamServiceContract>(RESTREAM_SERVICE);
    if (restream) {
      try {
        await restream.onEgressEvent(app, info.egressId, status);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log('error', `restream.onEgressEvent failed: ${message}`, {
          egressId: info.egressId,
          status,
        });
      }
    }
  }

  private async onIngressStarted(
    event: WebhookEvent,
    app: string | null,
  ): Promise<void> {
    const info = event.ingressInfo;
    if (!info || !app) return;

    // RTMP password enforcement (SPEC §16): if the ingress requires a password
    // and it has not been validated, terminate it. LiveKit has no native RTMP
    // password, so authorization happens out-of-band (POST /ingress/:id/validate,
    // e.g. from an RTMP edge on_publish hook) before/while the push starts.
    if (info.inputType === IngressInput.RTMP_INPUT) {
      try {
        if (!this.ingressAuth.isAuthorized(app, info.ingressId)) {
          await this.livekit.deleteIngress(info.ingressId);
          this.ingressAuth.remove(app, info.ingressId);
          this.log('warn', 'terminated unauthorized RTMP ingress (bad/missing password)', {
            ingressId: info.ingressId,
            room: info.roomName,
            app,
          });
          await this.dispatch(app, 'stream_ended', {
            streamId: info.ingressId,
            room: info.roomName,
            reason: 'unauthorized_rtmp_password',
          });
          return;
        }
      } catch (err) {
        this.log('error', `ingress auth enforcement failed: ${String(err)}`, {
          ingressId: info.ingressId,
        });
      }
    }

    // Dedupe ingress <-> its participant: 1 RTMP/WHIP/RTSP ingress = 1 stream.
    // Instead of creating a third row keyed by ingressId, we key the stream by
    // the ingress PARTICIPANT canonically (`${room}/${participantIdentity}`) —
    // the exact same key participant_joined and reconcile() use — and mark it
    // with the ingress type. When the participant identity isn't known yet we
    // skip the upsert; participant_joined / reconcile will create the canonical
    // row (marked 'rtmp' because the participant kind is INGRESS).
    const type = this.ingressType(info.inputType);
    const identity = info.participantIdentity || '';
    const streamId = identity
      ? this.streamKey(info.roomName, identity)
      : info.ingressId;
    if (identity) {
      await this.upsertStream(app, streamId, type, info.roomName, identity);
    }
    await this.dispatch(app, 'stream_started', {
      streamId,
      room: info.roomName,
      type,
      ingressId: info.ingressId,
    });
  }

  private async onIngressEnded(
    event: WebhookEvent,
    app: string | null,
  ): Promise<void> {
    const info = event.ingressInfo;
    if (!info || !app) return;
    const identity = info.participantIdentity || '';
    const streamId = identity
      ? this.streamKey(info.roomName, identity)
      : info.ingressId;
    await this.dispatch(app, 'stream_ended', {
      streamId,
      room: info.roomName,
      ingressId: info.ingressId,
    });
  }

  /**
   * A publisher published a track → this participant IS a stream now. Create /
   * update its canonical row and emit stream_started. Idempotent: a publisher
   * with multiple tracks (audio+video) fires this twice but the canonical key
   * collapses to one row (streams.upsert ON CONFLICT).
   */
  private async onTrackPublished(
    event: WebhookEvent,
    app: string | null,
  ): Promise<void> {
    const p = event.participant;
    const room = event.room?.name ?? '';
    if (!p || !app) return;
    // Skip hidden QC/recorder participants (SPEC §16): not a real stream.
    if (p.permission?.hidden) return;
    // Canonical key shared with ingress_started/reconcile — no duplicate rows.
    const streamId = this.streamKey(room, p.identity);
    // An ingress publisher shows up as a participant with kind === INGRESS.
    // Mark it 'rtmp' so it dedupes with its ingress_started event (1 ingress =
    // 1 stream). The streams.upsert never downgrades an ingress type to webrtc.
    const type: StreamType =
      p.kind === ParticipantInfo_Kind.INGRESS ? 'rtmp' : 'webrtc';
    await this.upsertStream(app, streamId, type, room, p.identity);
    await this.dispatch(app, 'stream_started', {
      streamId,
      room,
      type,
      participant: p.identity,
    });
  }

  /**
   * A publisher unpublished a track → close the stream. reconcile() re-creates
   * it on the next list() if the participant is still publishing another track,
   * so a partial unpublish never leaves a live stream permanently hidden.
   */
  private async onTrackUnpublished(
    event: WebhookEvent,
    app: string | null,
  ): Promise<void> {
    const p = event.participant;
    const room = event.room?.name ?? '';
    if (!p || !app) return;
    if (p.permission?.hidden) return;
    const streamId = this.streamKey(room, p.identity);
    await this.endStream(app, streamId);
    await this.dispatch(app, 'stream_ended', {
      streamId,
      room,
      participant: p.identity,
    });
  }

  private async onParticipantLeft(
    event: WebhookEvent,
    app: string | null,
  ): Promise<void> {
    const p = event.participant;
    const room = event.room?.name ?? '';
    if (!p || !app) return;
    if (p.permission?.hidden) return;
    const streamId = this.streamKey(room, p.identity);
    await this.endStream(app, streamId);
    await this.dispatch(app, 'stream_ended', {
      streamId,
      room,
      participant: p.identity,
    });
  }

  // ---------------------------------------------------------------------------
  // Downstream helpers (resilient)
  // ---------------------------------------------------------------------------

  private async upsertStream(
    app: string,
    streamId: string,
    type: StreamType,
    room: string,
    participant: string | null,
  ): Promise<void> {
    const streams = this.resolve<StreamsServiceContract>(STREAMS_SERVICE);
    if (!streams) return;
    try {
      await streams.upsert(app, streamId, type, room, participant);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `streams.upsert failed: ${message}`, { app, streamId });
    }
  }

  private async endStream(app: string, streamId: string): Promise<void> {
    const streams = this.resolve<StreamsServiceContract>(STREAMS_SERVICE);
    if (!streams) return;
    try {
      await streams.end(app, streamId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `streams.end failed: ${message}`, { app, streamId });
    }
  }

  private async dispatch(
    app: string,
    event: CallbackEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const callbacks = this.resolve<CallbacksServiceContract>(CALLBACKS_SERVICE);
    if (!callbacks) return;
    try {
      await callbacks.dispatch(app, event, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('error', `callbacks.dispatch failed: ${message}`, {
        app,
        event,
      });
    }
  }
}
