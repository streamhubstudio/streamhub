import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ModuleRef } from '@nestjs/core';

import { AuditService } from '../audit/audit.service';
import { RequirePermission } from '../authz/permission.decorator';
import {
  APPS_SERVICE,
  AppConfig,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { LiveKitService } from './livekit.service';
import { SendDataDto } from './dto/send-data.dto';
import {
  MuteParticipantDto,
  UpdateParticipantDto,
  UpdateRoomMetadataDto,
  UpdateSubscriptionsDto,
} from './dto/rooms.dto';

/**
 * Per-app rooms API (`/apps/:app/rooms/...`) — exposes the native LiveKit
 * server-side capabilities that were previously unused (see
 * https://streamhub.studio/docs/LIVEKIT-UNUSED-FEATURES):
 *
 *  - room & participant METADATA (`updateRoomMetadata` / `updateParticipant`):
 *    live JSON state (presence, roles, "on air" flags) with no DB round-trips —
 *    clients receive `roomMetadataChanged` / `participantMetadataChanged`;
 *  - server-side MODERATION: kick (`removeParticipant`), mute a published
 *    track (`mutePublishedTrack`), force-update subscriptions
 *    (`updateSubscriptions`);
 *  - server-side DATA push to a room (`sendData`) — the per-room twin of
 *    `POST /apps/:app/streams/:id/data`.
 *
 * Tenant isolation: every route namespaces the `:room` param under the app's
 * room prefix (exactly like the tokens/ingress endpoints), so an app can never
 * address another app's rooms.
 */
@ApiTags('rooms')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/rooms')
export class RoomsController {
  constructor(
    private readonly livekit: LiveKitService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Resolve the app's full config; null on any error (app missing, etc). */
  private async appConfig(app: string): Promise<AppConfig | null> {
    try {
      const apps = this.moduleRef.get<AppsServiceContract>(APPS_SERVICE, {
        strict: false,
      });
      return await apps.getConfig(app);
    } catch {
      return null;
    }
  }

  /** Best-effort moderation audit trail (never fails the action). */
  private audit(
    action: string,
    meta: Record<string, unknown>,
  ): void {
    try {
      const logs = this.moduleRef.get<LogsServiceContract>(LOGS_SERVICE, {
        strict: false,
      });
      logs.write('info', 'livekit-moderation', action, meta);
    } catch {
      /* logging must never break moderation */
    }
    // Also append to the structured security audit trail (ISO 8.15). Resolved
    // via ModuleRef (strict:false) like LOGS_SERVICE so bare-ctor specs and
    // audit-less graphs keep working; AuditService.record never throws.
    try {
      const audit = this.moduleRef.get(AuditService, { strict: false });
      audit?.record({
        action: `moderation.${action.replace(/[^a-z0-9]+/gi, '_')}`,
        actorType: 'system',
        targetType: 'room',
        targetId: typeof meta.room === 'string' ? meta.room : null,
        meta,
      });
    } catch {
      /* audit must never break moderation */
    }
  }

  /** The app's room prefix (falls back to the app name). */
  private async roomPrefix(app: string): Promise<string> {
    const cfg = await this.appConfig(app);
    return cfg?.roomPrefix || app;
  }

  /** Namespace a requested room under the app prefix (tenant isolation). */
  private async resolveRoom(app: string, room: string): Promise<string> {
    const prefix = await this.roomPrefix(app);
    if (!room) return prefix;
    return room === prefix || room.startsWith(`${prefix}-`)
      ? room
      : `${prefix}-${room}`;
  }

  // ---------------------------------------------------------------------------
  // Rooms & metadata
  // ---------------------------------------------------------------------------

  @Get()
  @RequirePermission('stream', 'read')
  @ApiOperation({
    summary: 'List the app\'s live rooms (name, participants, metadata).',
  })
  async listRooms(@Param('app') app: string) {
    const prefix = await this.roomPrefix(app);
    const rooms = await this.livekit.listRoomsDetailed();
    const data = rooms.filter(
      (r) => r.name === prefix || r.name.startsWith(`${prefix}-`),
    );
    return { data };
  }

  @Get(':room')
  @RequirePermission('stream', 'read')
  @ApiOperation({ summary: 'Get one live room (with its metadata).' })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async getRoom(@Param('app') app: string, @Param('room') roomParam: string) {
    const room = await this.resolveRoom(app, roomParam);
    const info = await this.livekit.getRoom(room);
    if (!info) throw new NotFoundException(`room '${room}' is not live`);
    return { data: info };
  }

  @Patch(':room/metadata')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary:
      'Set the room\'s live metadata (clients receive roomMetadataChanged).',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async updateRoomMetadata(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Body() dto: UpdateRoomMetadataDto,
  ) {
    const room = await this.resolveRoom(app, roomParam);
    const info = await this.livekit.updateRoomMetadata(room, dto.metadata);
    return { data: info };
  }

  // ---------------------------------------------------------------------------
  // Participants: listing, metadata, moderation
  // ---------------------------------------------------------------------------

  @Get(':room/participants')
  @RequirePermission('stream', 'read')
  @ApiOperation({
    summary:
      'List the room\'s participants with their published tracks (sids) — ' +
      'feeds the moderation actions.',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async listParticipants(
    @Param('app') app: string,
    @Param('room') roomParam: string,
  ) {
    const room = await this.resolveRoom(app, roomParam);
    const data = await this.livekit.listParticipantsDetailed(room);
    return { data };
  }

  @Delete(':room/participants/:identity')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary: 'Kick a participant out of the room (removeParticipant).',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  @ApiParam({ name: 'identity', description: 'Participant identity.' })
  async kickParticipant(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Param('identity') identity: string,
  ) {
    const room = await this.resolveRoom(app, roomParam);
    await this.livekit.removeParticipant(room, identity);
    this.audit('participant kicked', { app, room, identity });
    return { data: { room, identity, removed: true } };
  }

  @Post(':room/participants/:identity/mute')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary:
      'Server-side mute/unmute of a participant\'s published track(s) ' +
      '(mutePublishedTrack). Pass trackSid, or kind=audio|video|all.',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  @ApiParam({ name: 'identity', description: 'Participant identity.' })
  async muteParticipant(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Param('identity') identity: string,
    @Body() dto: MuteParticipantDto,
  ) {
    const room = await this.resolveRoom(app, roomParam);
    const muted = dto.muted ?? true;

    let sids: string[];
    if (dto.trackSid) {
      sids = [dto.trackSid];
    } else {
      const p = await this.livekit.getParticipant(room, identity);
      const kind = dto.kind ?? 'all';
      sids = p.tracks
        .filter((t) => kind === 'all' || t.type === kind)
        .map((t) => t.sid);
      if (sids.length === 0) {
        throw new NotFoundException(
          `participant '${identity}' has no ${kind === 'all' ? '' : kind + ' '}tracks to ${muted ? 'mute' : 'unmute'}`,
        );
      }
    }

    const results = [];
    for (const sid of sids) {
      results.push(
        await this.livekit.mutePublishedTrack(room, identity, sid, muted),
      );
    }
    this.audit('participant track(s) muted', {
      app,
      room,
      identity,
      muted,
      tracks: results.map((r) => r.trackSid),
    });
    return { data: { room, identity, muted, tracks: results } };
  }

  @Patch(':room/participants/:identity')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary:
      'Update a participant\'s metadata / name / permissions ' +
      '(updateParticipant). Clients receive participantMetadataChanged.',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  @ApiParam({ name: 'identity', description: 'Participant identity.' })
  async updateParticipant(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Param('identity') identity: string,
    @Body() dto: UpdateParticipantDto,
  ) {
    const room = await this.resolveRoom(app, roomParam);

    // LiveKit applies permissions ATOMICALLY: when any permission override is
    // requested, merge it over the participant's current grant so unspecified
    // permissions are preserved instead of silently reset.
    const wantsPermission =
      dto.canPublish !== undefined ||
      dto.canSubscribe !== undefined ||
      dto.canPublishData !== undefined;

    let permission:
      | {
          canPublish?: boolean;
          canSubscribe?: boolean;
          canPublishData?: boolean;
          hidden?: boolean;
        }
      | undefined;
    if (wantsPermission) {
      const current = await this.currentPermission(room, identity);
      permission = {
        ...current,
        ...(dto.canPublish !== undefined ? { canPublish: dto.canPublish } : {}),
        ...(dto.canSubscribe !== undefined
          ? { canSubscribe: dto.canSubscribe }
          : {}),
        ...(dto.canPublishData !== undefined
          ? { canPublishData: dto.canPublishData }
          : {}),
      };
    }

    const data = await this.livekit.updateParticipant(room, identity, {
      metadata: dto.metadata,
      name: dto.name,
      permission,
    });
    return { data };
  }

  @Post(':room/participants/:identity/subscriptions')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary:
      'Force-subscribe / force-unsubscribe a participant to specific tracks ' +
      '(updateSubscriptions).',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  @ApiParam({ name: 'identity', description: 'Participant identity.' })
  async updateSubscriptions(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Param('identity') identity: string,
    @Body() dto: UpdateSubscriptionsDto,
  ) {
    const room = await this.resolveRoom(app, roomParam);
    await this.livekit.updateSubscriptions(
      room,
      identity,
      dto.trackSids,
      dto.subscribe,
    );
    return {
      data: {
        room,
        identity,
        trackSids: dto.trackSids,
        subscribe: dto.subscribe,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Server-side data push (per-room twin of POST /streams/:id/data)
  // ---------------------------------------------------------------------------

  @Post(':room/data')
  @RequirePermission('stream', 'write')
  @ApiOperation({
    summary:
      'Push a server-side data message to every subscriber of the room over ' +
      'LiveKit data channels (RoomServiceClient.sendData).',
  })
  @ApiParam({ name: 'room', description: 'Room name within the app.' })
  async sendData(
    @Param('app') app: string,
    @Param('room') roomParam: string,
    @Body() dto: SendDataDto,
  ) {
    const cfg = await this.appConfig(app);
    // Same feature gates as the per-stream endpoint: chat topic needs `chat`,
    // reaction needs `reactions`.
    if (cfg) {
      if (dto.topic === 'chat' && !cfg.features.chat) {
        throw new NotFoundException('chat is disabled for this app');
      }
      if (dto.topic === 'reaction' && !cfg.features.reactions) {
        throw new NotFoundException('reactions are disabled for this app');
      }
    }
    const room = cfg
      ? this.namespaceRoom(cfg.roomPrefix || app, roomParam)
      : await this.resolveRoom(app, roomParam);

    const envelope = {
      topic: dto.topic,
      from: dto.from,
      message: dto.message,
      reaction: dto.reaction,
      ts: new Date().toISOString(),
    };
    const payload = dto.payload ?? JSON.stringify(envelope);

    await this.livekit.sendData(room, payload, {
      topic: dto.topic,
      destinationIdentities: dto.destinationIdentities,
      reliable: dto.reliable,
    });
    return { data: { sent: true, room, topic: dto.topic } };
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** Namespace a room under a known prefix (no async lookup). */
  private namespaceRoom(prefix: string, room?: string): string {
    if (!room) return prefix;
    return room === prefix || room.startsWith(`${prefix}-`)
      ? room
      : `${prefix}-${room}`;
  }

  /**
   * Current permission grant of a participant, as the merge base for atomic
   * permission updates. LiveKit hiccup → {} (overrides then form the set).
   */
  private async currentPermission(
    room: string,
    identity: string,
  ): Promise<{
    canPublish?: boolean;
    canSubscribe?: boolean;
    canPublishData?: boolean;
    hidden?: boolean;
  }> {
    try {
      const p = await this.livekit.getParticipant(room, identity);
      return { ...p.permission };
    } catch {
      return {};
    }
  }
}
