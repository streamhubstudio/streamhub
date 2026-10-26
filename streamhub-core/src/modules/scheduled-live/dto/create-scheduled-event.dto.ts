import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for POST /apps/:app/scheduled-live — schedule ONE live premiere.
 *
 * `startAt` is the ABSOLUTE reveal instant (unix epoch MILLISECONDS, UTC). The
 * browser computes it from the operator's picked wall-time + IANA timezone; the
 * backend does no timezone math — it only validates a positive integer and keeps
 * `timezone` for round-trip editing / display.
 */
export class CreateScheduledEventDto {
  @ApiProperty({
    example: 1893456000000,
    description:
      'Absolute reveal instant as unix epoch MILLISECONDS (UTC). Computed ' +
      'browser-side from the picked wall-time + timezone.',
  })
  @IsInt()
  @IsPositive()
  startAt!: number;

  @ApiPropertyOptional({
    example: 'America/Argentina/Buenos_Aires',
    description: 'IANA timezone the wall-time was picked in (display/round-trip).',
    default: 'UTC',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    example: 'room1',
    description:
      'Room this premiere applies to. Omit / null → every room in the app.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  room?: string | null;

  @ApiPropertyOptional({
    example: 'Gran estreno',
    description: 'Friendly title shown in the agenda and on the cover.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @ApiPropertyOptional({
    example: 'El vivo comienza en breve.',
    description: 'Optional message shown under the countdown headline.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;

  @ApiPropertyOptional({
    default: true,
    description: 'Whether the event is active (drives the countdown).',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
