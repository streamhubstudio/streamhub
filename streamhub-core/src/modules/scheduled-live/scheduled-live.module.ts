import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { ScheduledLiveController } from './scheduled-live.controller';
import { ScheduledLiveRepository } from './scheduled-live.repository';
import { ScheduledLiveService } from './scheduled-live.service';

/**
 * Scheduled-live module: the per-app agenda of scheduled live-stream premieres.
 * A CRUD feature over the app's `scheduled_events` table (DbService is global).
 * The `scheduled-live` player-overlay plugin reads the public agenda to drive
 * the countdown cover client-side; on every agenda mutation the service pushes
 * an `agenda-updated` LiveKit data message (topic `scheduled-live`) to the
 * affected room(s) so connected players refetch instantly — the overlay's 30 s
 * poll remains as fallback. LiveKitModule provides the (optional) LiveKitService
 * used for that push. AppsModule (APPS_SERVICE) lets the controller resolve the
 * app's configured timezone as the default for a new/updated event (owner
 * item 11) — no cycle, AppsModule doesn't depend back on this module.
 */
@Module({
  imports: [LiveKitModule, AppsModule],
  controllers: [ScheduledLiveController],
  providers: [ScheduledLiveService, ScheduledLiveRepository],
  exports: [ScheduledLiveService],
})
export class ScheduledLiveModule {}
