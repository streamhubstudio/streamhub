import { Module } from '@nestjs/common';
import { RECORDING_SERVICE } from '../../shared/contracts';
import { AppsModule } from '../apps/apps.module';
import { LiveKitModule } from '../livekit/livekit.module';
import { S3Module } from '../s3/s3.module';
import { StreamsModule } from '../streams/streams.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { AppStatsService } from './app-stats.service';
import { DrmService } from './drm/drm.service';
import { RecordingController } from './recording.controller';
import { RecordingService } from './recording.service';
import { VodsRepository } from './vods.repository';
import { VodVariantsRepository } from './vod-variants.repository';
import { VodTranscodeService } from './vod-transcode.service';
import { VodRetentionService } from './vod-retention.service';

/**
 * Recording orchestration module. Imports the LiveKit/S3/Apps modules to consume
 * their service contracts (Logs/Callbacks/Db/Config are global). Exports
 * RECORDING_SERVICE so the livekit webhook handler can advance the flow.
 * VodTranscodeService owns the ffmpeg post-transcode pipeline (adaptive HLS
 * ladder + WebM alternate) fed by RecordingService after each upload;
 * DrmService decides clear-vs-encrypted packaging per app (features.drm,
 * default off — see drm/ and https://streamhub.studio/docs/features/DRM).
 */
@Module({
  // TranscriptionModule rides in here (NOT in app.module.ts): importing it
  // registers its controller and provides TranscriptionService, which
  // RecordingService pings (optionally) after each vod_ready.
  imports: [
    LiveKitModule,
    S3Module,
    AppsModule,
    StreamsModule,
    TranscriptionModule,
  ],
  controllers: [RecordingController],
  providers: [
    RecordingService,
    VodsRepository,
    VodVariantsRepository,
    VodTranscodeService,
    VodRetentionService,
    DrmService,
    AppStatsService,
    { provide: RECORDING_SERVICE, useExisting: RecordingService },
  ],
  exports: [RecordingService, RECORDING_SERVICE],
})
export class RecordingModule {}
