import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for PATCH /apps/:app/scheduled-live/:id — update a scheduled premiere.
 * Every field is optional; only the present ones are written. `startAt` (when
 * given) stays an absolute unix epoch MS in UTC, same as on create.
 */
export class PatchScheduledEventDto {
  @ApiPropertyOptional({
    example: 1893456000000,
    description: 'New absolute reveal instant (unix epoch MILLISECONDS, UTC).',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  startAt?: number;

  @ApiPropertyOptional({
    example: 'America/Argentina/Buenos_Aires',
    description: 'IANA timezone the wall-time was picked in.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    example: 'room1',
    description: 'Room this premiere applies to (null → every room).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  room?: string | null;

  @ApiPropertyOptional({ example: 'Gran estreno' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @ApiPropertyOptional({ example: 'El vivo comienza en breve.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;

  @ApiPropertyOptional({ description: 'Enable / disable the event.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
