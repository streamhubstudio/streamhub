import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { PluginsModule } from '../plugins/plugins.module';
import { S3Module } from '../s3/s3.module';
import { VodsRepository } from '../recording/vods.repository';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionService } from './transcription.service';
import { TranscriptsRepository } from './transcripts.repository';

/**
 * VOD transcription backend (module `transcription`) — the server side of the
 * `transcription` plugin (src/plugins/transcription): mp3 extraction, the
 * local-worker/OpenAI engines, SRT upload to the app S3 and the per-VOD
 * transcript rows (vod_transcripts).
 *
 * Wiring note: this module is NOT registered in app.module.ts — it is pulled
 * in transitively by RecordingModule (which also injects TranscriptionService
 * as its optional `vod_ready` hook), so its controller registers without any
 * scaffolder-owned file changing. VodsRepository is re-provided here (it only
 * depends on the global DbService; a second stateless instance is harmless
 * and avoids a Recording↔Transcription module cycle).
 */
@Module({
  imports: [AppsModule, S3Module, PluginsModule],
  controllers: [TranscriptionController],
  providers: [TranscriptsRepository, VodsRepository, TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
