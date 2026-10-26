import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { LiveKitService } from '../livekit/livekit.service';
import {
  ScheduledEventPatch,
  ScheduledEventView,
  ScheduledLiveRepository,
} from './scheduled-live.repository';
import { CreateScheduledEventDto } from './dto/create-scheduled-event.dto';
import { PatchScheduledEventDto } from './dto/patch-scheduled-event.dto';

export type { ScheduledEventView } from './scheduled-live.repository';

/** How far back a public listing looks so a just-started reveal is still shown. */
const PUBLIC_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * LiveKit data-channel topic of the real-time agenda push. The player overlay
 * subscribes to it and refetches the public agenda immediately instead of
 * waiting for its 30 s poll (which stays as the fallback transport).
 */
export const SCHEDULED_LIVE_TOPIC = 'scheduled-live';

const MAX_TITLE = 200;
const MAX_MESSAGE = 500;
const MAX_ROOM = 200;
const MAX_TIMEZONE = 64;

/**
 * Scheduled-live agenda service (module `scheduled-live`). A thin, validating
 * wrapper over the repository. It owns NO timezone math — `startAt` is already
 * an absolute unix epoch MS in UTC (the browser converts wall-time + IANA zone);
 * the service only defends the invariant (finite positive integer) and caps the
 * free-text fields, so a bad API caller can't poison the app.db.
 *
 * Owner item 11 precedence: `timezone` is stored purely for display/round-trip
 * (see above) — when the caller omits/empties it, `create`/`update` fall back
 * to their `defaultTimezone` parameter, which the CONTROLLER resolves from the
 * app's config (`AppConfig.timezone`). So: explicit event timezone > app
 * timezone > `'UTC'`. An explicit event timezone is NEVER overridden.
 */
@Injectable()
export class ScheduledLiveService {
  private readonly logger = new Logger(ScheduledLiveService.name);

  constructor(
    private readonly repo: ScheduledLiveRepository,
    // Real-time push (LIVEKIT-UNUSED-FEATURES item 1): both optional so the
    // service still constructs bare in unit tests / minimal DI contexts —
    // without them agenda changes simply aren't pushed (the poll still works).
    @Optional() private readonly livekit?: LiveKitService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** Full agenda for the operator (every event, soonest first). */
  list(app: string): ScheduledEventView[] {
    return this.repo.list(app);
  }

  /**
   * Enabled, not-yet-past events for the anonymous player. `sinceMs` defaults to
   * a 24h lookback so an event whose reveal just fired is still returned (the
   * client's reveal-window animation needs it); very old events are excluded to
   * keep the payload bounded.
   */
  listPublic(app: string, room?: string, sinceMs?: number): ScheduledEventView[] {
    const cutoff =
      typeof sinceMs === 'number' && Number.isFinite(sinceMs)
        ? sinceMs
        : Date.now() - PUBLIC_LOOKBACK_MS;
    const roomFilter = room && room.trim() ? room.trim() : undefined;
    return this.repo.listPublic(app, roomFilter, cutoff);
  }

  get(app: string, id: number): ScheduledEventView {
    const row = this.repo.get(app, id);
    if (!row) throw new NotFoundException(`scheduled event '${id}' not found`);
    return row;
  }

  /**
   * `defaultTimezone` (owner item 11) is what an OMITTED/empty `dto.timezone`
   * falls back to — the controller resolves it from the app's config
   * (`AppConfig.timezone`), so the app's timezone becomes the default when the
   * caller doesn't pick one explicitly. Falls back to `'UTC'` when the caller
   * doesn't pass one (existing callers/tests keep their historical default).
   */
  create(
    app: string,
    dto: CreateScheduledEventDto,
    defaultTimezone = 'UTC',
  ): ScheduledEventView {
    const created = this.repo.create(app, {
      startAt: this.validateStartAt(dto.startAt),
      timezone: this.normalizeTimezone(dto.timezone, defaultTimezone),
      room: this.normalizeText(dto.room, MAX_ROOM, 'room'),
      title: this.normalizeText(dto.title, MAX_TITLE, 'title'),
      message: this.normalizeText(dto.message, MAX_MESSAGE, 'message'),
      enabled: dto.enabled ?? true,
    });
    void this.notifyAgendaChanged(app, created.room);
    return created;
  }

  /** See {@link create} for `defaultTimezone`. */
  update(
    app: string,
    id: number,
    dto: PatchScheduledEventDto,
    defaultTimezone = 'UTC',
  ): ScheduledEventView {
    // Ensure it exists first so an unknown id is a clean 404 (not a silent no-op).
    const before = this.get(app, id);

    const patch: ScheduledEventPatch = {};
    if (dto.startAt !== undefined) patch.startAt = this.validateStartAt(dto.startAt);
    if (dto.timezone !== undefined) {
      patch.timezone = this.normalizeTimezone(dto.timezone, defaultTimezone);
    }
    if (dto.room !== undefined) patch.room = this.normalizeText(dto.room, MAX_ROOM, 'room');
    if (dto.title !== undefined) patch.title = this.normalizeText(dto.title, MAX_TITLE, 'title');
    if (dto.message !== undefined) {
      patch.message = this.normalizeText(dto.message, MAX_MESSAGE, 'message');
    }
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;

    const updated = this.repo.update(app, id, patch) as ScheduledEventView;
    // Notify the (possibly re-homed) event's room; when the room changed, the
    // old room's viewers also need a refetch (their event moved away).
    void this.notifyAgendaChanged(app, updated.room);
    if (before.room !== updated.room) {
      void this.notifyAgendaChanged(app, before.room);
    }
    return updated;
  }

  remove(app: string, id: number): { removed: true } {
    const before = this.repo.get(app, id);
    if (!this.repo.remove(app, id)) {
      throw new NotFoundException(`scheduled event '${id}' not found`);
    }
    void this.notifyAgendaChanged(app, before?.room ?? null);
    return { removed: true };
  }

  // ---------------------------------------------------------------------------
  // Real-time push (LiveKit data channels — LIVEKIT-UNUSED-FEATURES item 1)
  // ---------------------------------------------------------------------------

  /**
   * Push an `agenda-updated` data message (topic `scheduled-live`) to the
   * LiveKit room(s) affected by an agenda mutation, so connected players
   * refetch the public agenda immediately instead of waiting for the 30 s poll.
   *
   * `eventRoom` is the event's room field (short or prefixed name); null means
   * "all rooms of the app" → every live room under the app prefix is notified.
   * Strictly best-effort: any failure is logged and swallowed — the agenda
   * mutation NEVER fails because of the push, and the poll remains the
   * fallback transport.
   */
  private async notifyAgendaChanged(
    app: string,
    eventRoom: string | null,
  ): Promise<void> {
    if (!this.livekit) return;
    try {
      const prefix = await this.roomPrefix(app);
      let rooms: string[];
      if (eventRoom) {
        rooms = [this.namespaceRoom(prefix, eventRoom)];
      } else {
        const live = await this.livekit.listRooms();
        rooms = live
          .map((r) => r.name)
          .filter((n) => n === prefix || n.startsWith(`${prefix}-`));
      }
      const payload = JSON.stringify({
        type: 'agenda-updated',
        app,
        room: eventRoom ?? null,
        at: new Date().toISOString(),
      });
      for (const room of rooms) {
        try {
          await this.livekit.sendData(room, payload, {
            topic: SCHEDULED_LIVE_TOPIC,
            reliable: true,
          });
        } catch {
          /* per-room best-effort: an idle room simply has nobody to notify */
        }
      }
    } catch (err) {
      this.logger.warn(
        `agenda push skipped: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** The app's room prefix (AppsService when resolvable, else the app name). */
  private async roomPrefix(app: string): Promise<string> {
    try {
      const apps = this.moduleRef?.get<AppsServiceContract>(APPS_SERVICE, {
        strict: false,
      });
      if (!apps) return app;
      const cfg = await apps.getConfig(app);
      return cfg.roomPrefix || app;
    } catch {
      return app;
    }
  }

  /** Namespace a room under the app prefix (same rule as the livekit module). */
  private namespaceRoom(prefix: string, room: string): string {
    return room === prefix || room.startsWith(`${prefix}-`)
      ? room
      : `${prefix}-${room}`;
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  private validateStartAt(raw: number): number {
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new BadRequestException(
        'startAt must be a positive integer (unix epoch ms, UTC)',
      );
    }
    return raw;
  }

  /**
   * Owner item 11: an omitted/empty `timezone` falls back to `defaultTimezone`
   * (the app's configured timezone, resolved by the controller — see
   * {@link ScheduledLiveService.create}) instead of a hardcoded `'UTC'`, so the
   * app-level default takes effect exactly when the caller leaves this field
   * empty. Still no timezone MATH here (see the class doc) — just which
   * string gets stored for display/round-trip.
   */
  private normalizeTimezone(
    raw: string | undefined,
    defaultTimezone: string,
  ): string {
    const tz = (raw ?? '').trim();
    if (!tz) return defaultTimezone.trim() || 'UTC';
    if (tz.length > MAX_TIMEZONE) {
      throw new BadRequestException(`timezone must be <= ${MAX_TIMEZONE} chars`);
    }
    return tz;
  }

  /** Trim + length-cap a free-text field; empty → null. */
  private normalizeText(
    raw: string | null | undefined,
    max: number,
    field: string,
  ): string | null {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (s.length > max) {
      throw new BadRequestException(`${field} must be <= ${max} chars`);
    }
    return s;
  }
}
