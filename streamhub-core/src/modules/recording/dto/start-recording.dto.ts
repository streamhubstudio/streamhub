import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** recordMode values (LIVEKIT-UNUSED-FEATURES "track/audio-only egress"). */
export const RECORD_MODES = ['composite', 'track', 'audio'] as const;

/**
 * Body for POST /apps/:app/recording/start (SPEC §6, §8).
 * The composite recording `mode` (room-composite | participant) and layout come
 * from the app's config.yaml; `recordMode` optionally overrides the egress
 * KIND: `track`/`audio` record ONE publisher via TrackCompositeEgress (ffmpeg,
 * no headless Chrome), `composite` (default) keeps the config behaviour.
 */
export class StartRecordingDto {
  @ApiProperty({
    example: 'live-room-1',
    description: 'LiveKit room to record.',
  })
  @IsString()
  @MaxLength(200)
  roomName!: string;

  @ApiPropertyOptional({
    example: 'cam-42',
    description:
      'Logical stream id. In participant/track/audio modes it is also used as the participant identity to egress.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  streamId?: string;

  @ApiPropertyOptional({
    enum: RECORD_MODES,
    description:
      'composite (default, per app config — headless-Chrome room render) | ' +
      'track (one publisher audio+video, ffmpeg TrackComposite, no Chrome) | ' +
      'audio (audio-only TrackComposite).',
  })
  @IsOptional()
  @IsIn(RECORD_MODES as unknown as string[])
  recordMode?: (typeof RECORD_MODES)[number];

  @ApiPropertyOptional({
    example: 'ingress-live',
    description:
      'Publisher identity for track/audio modes. Defaults to streamId.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  participantIdentity?: string;
}

/**
 * Optional body for POST /apps/:app/streams/:id/record/start — same record
 * mode override for the record-live flow (the room comes from the stream).
 */
export class RecordStreamDto {
  @ApiPropertyOptional({
    enum: RECORD_MODES,
    description: 'composite (default) | track | audio.',
  })
  @IsOptional()
  @IsIn(RECORD_MODES as unknown as string[])
  recordMode?: (typeof RECORD_MODES)[number];

  @ApiPropertyOptional({
    description:
      'Publisher identity for track/audio modes. Defaults to the stream participant/id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  participantIdentity?: string;
}
