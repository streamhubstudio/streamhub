/**
 * REST surface of the transcription plugin (module `transcription`):
 * per-VOD trigger + transcript/SRT reads, scoped under /apps/:app/vods/:id.
 * Auth = global Bearer guard; permissions mirror the other VOD routes
 * (vod:read / vod:write).
 */
import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermission } from '../authz/permission.decorator';
import { TranscriptView, TranscriptionService } from './transcription.service';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

@ApiTags('transcription')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app')
export class TranscriptionController {
  constructor(private readonly transcription: TranscriptionService) {}

  @Post('vods/:id/transcribe')
  @RequirePermission('vod', 'write')
  @ApiOperation({
    summary: 'Trigger (or re-run) transcription of a ready VOD.',
    description:
      'Requires the `transcription` plugin installed + enabled in the app. ' +
      'Extracts the audio (mp3), transcribes it with the configured provider ' +
      "(local faster-whisper worker by default, or OpenAI's API) and uploads " +
      'the resulting SRT next to the VOD in the app S3 bucket. Asynchronous: ' +
      'returns the transcript row in `queued` state — poll GET .../transcript.',
  })
  @ApiParam({ name: 'id', description: 'VOD id (numeric).' })
  @ApiOkResponse({ description: '{ data: TranscriptView (status queued) }' })
  @ApiConflictResponse({
    description: 'VOD not ready, or a transcription is already in progress.',
  })
  async transcribe(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Envelope<TranscriptView>> {
    return ok(await this.transcription.trigger(app, id));
  }

  @Get('vods/:id/transcript')
  @RequirePermission('vod', 'read')
  @ApiOperation({
    summary: "A VOD's transcript (status, text, segments, speakers, SRT).",
    description:
      'Returns the transcript row: `status` (queued|processing|ready|failed), ' +
      'the plain text, timed `segments` (with per-track speaker labels when ' +
      'attributable), the distinct `speakers`, and `srtKey`/`srtUrl` (a fresh ' +
      'presigned URL of the SRT uploaded to the app S3). 404 when the VOD was ' +
      'never transcribed.',
  })
  @ApiParam({ name: 'id', description: 'VOD id (numeric).' })
  @ApiOkResponse({ description: '{ data: TranscriptView }' })
  async transcript(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Envelope<TranscriptView>> {
    return ok(await this.transcription.getTranscript(app, id));
  }

  @Get('vods/:id/transcript.srt')
  @RequirePermission('vod', 'read')
  @ApiOperation({
    summary: 'Download the SRT subtitle file of a transcribed VOD.',
    description:
      'Serves the SubRip document rebuilt from the stored segments (works ' +
      'even if the S3 upload failed). 404 without a transcript, 409 while ' +
      'not ready.',
  })
  @ApiParam({ name: 'id', description: 'VOD id (numeric).' })
  @ApiOkResponse({ description: 'The SRT file (application/x-subrip).' })
  @ApiConflictResponse({ description: 'Transcript is not ready yet.' })
  async transcriptSrt(
    @Param('app') app: string,
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { filename, content } = await this.transcription.getSrt(app, id);
    res.set({
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return content;
  }
}
