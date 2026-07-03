import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body for POST /apps/:app/snapshots (SPEC §6, §5 streams). */
export class SnapshotDto {
  @ApiProperty({
    description: 'LiveKit room name to snapshot.',
    example: 'live/lobby',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  room!: string;

  @ApiPropertyOptional({
    description:
      'Optional participant identity to snapshot; defaults to the room composite.',
    example: 'camera-1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  participantIdentity?: string;
}
