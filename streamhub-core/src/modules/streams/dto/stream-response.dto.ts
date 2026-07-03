import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StreamStatus, StreamType } from '../../../shared/contracts';

/** Mirrors the StreamRecord contract for OpenAPI docs. */
export class StreamResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 1 })
  appId!: number;

  @ApiProperty({ example: 'live/lobby/camera-1' })
  streamId!: string;

  @ApiProperty({ enum: ['webrtc', 'rtmp', 'rtsp', 'whip'], example: 'webrtc' })
  type!: StreamType;

  @ApiProperty({ example: 'live/lobby' })
  room!: string;

  @ApiPropertyOptional({ nullable: true, example: 'camera-1' })
  participant!: string | null;

  @ApiProperty({ enum: ['active', 'ended'], example: 'active' })
  status!: StreamStatus;

  @ApiProperty({ example: '2026-06-30T12:00:00.000Z' })
  startedAt!: string;

  @ApiPropertyOptional({ nullable: true, example: null })
  endedAt!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '{"live":true,"participants":2,"publishers":1,"viewers":1}',
  })
  lastStatsJson!: string | null;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Live subscriber count (SPEC §16): excludes publishers and hidden/QC. Present on detail reads when features.viewerCounter is on.',
  })
  viewers?: number;
}

/** Result of POST /apps/:app/snapshots. */
export class SnapshotResultDto {
  @ApiProperty({ example: 'streamhub/live/snapshots/lobby-2026-06-30.jpg' })
  key!: string;

  @ApiProperty({
    example: 'https://s3.us-east-1.wasabisys.com/ale-backup/...signed',
  })
  url!: string;
}
