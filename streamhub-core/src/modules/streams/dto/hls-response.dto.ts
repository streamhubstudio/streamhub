import { ApiProperty } from '@nestjs/swagger';

/** Payload of `POST /apps/:app/streams/:id/hls/start`. */
export class HlsStartDataDto {
  @ApiProperty({ description: 'LiveKit egress id of the HLS egress.' })
  egressId!: string;

  @ApiProperty({
    description: 'Public URL of the live HLS playlist (.m3u8).',
    example:
      'https://streamhub.example.com/hls/live/live-room1/index.m3u8',
  })
  playlistUrl!: string;

  @ApiProperty({
    description: 'Egress status (e.g. EGRESS_STARTING / EGRESS_ACTIVE).',
  })
  status!: string;
}

/** Envelope for the HLS start response. */
export class HlsStartResponseDto {
  @ApiProperty({ type: HlsStartDataDto })
  data!: HlsStartDataDto;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  error!: null;
}

/** Payload of `POST /apps/:app/streams/:id/hls/stop`. */
export class HlsStopDataDto {
  @ApiProperty({
    nullable: true,
    description: 'Egress id that was stopped, or null if none was active.',
  })
  egressId!: string | null;

  @ApiProperty({
    description: 'Resulting status (e.g. EGRESS_ENDING / inactive).',
  })
  status!: string;
}

/** Envelope for the HLS stop response. */
export class HlsStopResponseDto {
  @ApiProperty({ type: HlsStopDataDto })
  data!: HlsStopDataDto;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  error!: null;
}

/** Payload of `GET /apps/:app/streams/:id/hls`. */
export class HlsStatusDataDto {
  @ApiProperty({ description: 'Whether a live HLS playlist is available.' })
  active!: boolean;

  @ApiProperty({ description: 'Public URL of the live HLS playlist (.m3u8).' })
  playlistUrl!: string;
}

/** Envelope for the HLS status response. */
export class HlsStatusResponseDto {
  @ApiProperty({ type: HlsStatusDataDto })
  data!: HlsStatusDataDto;

  @ApiProperty({ type: 'string', nullable: true, example: null })
  error!: null;
}
