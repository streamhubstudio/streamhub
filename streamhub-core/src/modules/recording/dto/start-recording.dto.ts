import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /apps/:app/recording/start (SPEC §6, §8).
 * The recording `mode` (room-composite | participant) and layout come from the
 * app's config.yaml, not the request.
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
      'Logical stream id. In participant mode it is also used as the participant identity to egress.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  streamId?: string;
}
