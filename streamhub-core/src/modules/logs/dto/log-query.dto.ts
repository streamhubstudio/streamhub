import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LogLevel } from '../../../shared/contracts';

/** Allowed log levels (mirrors the `LogLevel` contract type). */
export const LOG_LEVELS: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

/**
 * Shared filters for the log endpoints (SPEC §5 logs, §6). This base is what the
 * per-app viewer (`GET /apps/:app/logs`) accepts — the app is taken from the
 * path, so it deliberately has NO `app` field. The global `GET /logs`
 * ({@link LogQueryDto}) adds `app` on top. All fields optional; the service
 * applies sensible defaults + caps (limit 1..1000, default 100).
 */
export class AppLogQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by log level.',
    enum: LOG_LEVELS as LogLevel[],
  })
  @IsOptional()
  @IsIn(LOG_LEVELS as LogLevel[])
  level?: LogLevel;

  @ApiPropertyOptional({
    description: 'ISO-8601 lower bound (inclusive).',
    example: '2026-06-30T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601 upper bound (inclusive).',
    example: '2026-06-30T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601()
  until?: string;

  @ApiPropertyOptional({
    description: 'Filter by exact source (the emitting subsystem).',
    example: 'livekit-webhook',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  @ApiPropertyOptional({
    description: 'Free-text search over the message (case-sensitive LIKE %…%).',
    example: 'egress_ended',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    description: 'Max rows to return.',
    default: 100,
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ description: 'Rows to skip.', default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Query/filters for the global `GET /logs`. Same as {@link AppLogQueryDto} plus
 * an `app` filter (the per-app endpoint scopes by the path instead).
 */
export class LogQueryDto extends AppLogQueryDto {
  @ApiPropertyOptional({ description: 'Filter by app name.', example: 'live' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  app?: string;
}
