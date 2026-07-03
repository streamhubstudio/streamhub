import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { VodStatus } from '../../../shared/contracts';

const VOD_STATUSES: VodStatus[] = ['recording', 'uploading', 'ready', 'failed'];
const ORDER_FIELDS = ['started_at', 'size_bytes', 'id'] as const;
const DIRS = ['asc', 'desc'] as const;

/**
 * Query for GET /apps/:app/vods — filters + ordering + paging. Values arrive as
 * strings; `@Type`/`@Transform` coerce numbers and the `all` flag. limit/offset
 * range-clamping (1..1000 / >=0) is done in the service, preserving the historical
 * clamp-not-reject behaviour.
 */
export class ListVodsDto {
  @ApiPropertyOptional({ description: 'Exact room filter.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  room?: string;

  @ApiPropertyOptional({
    enum: VOD_STATUSES,
    description: 'Exact status filter.',
  })
  @IsOptional()
  @IsIn(VOD_STATUSES)
  status?: VodStatus;

  @ApiPropertyOptional({
    description: 'started_at lower bound (inclusive), ISO-8601.',
  })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({
    description: 'started_at upper bound (inclusive), ISO-8601.',
  })
  @IsOptional()
  @IsISO8601()
  until?: string;

  @ApiPropertyOptional({ enum: ORDER_FIELDS, default: 'id' })
  @IsOptional()
  @IsIn(ORDER_FIELDS)
  order?: (typeof ORDER_FIELDS)[number];

  @ApiPropertyOptional({ enum: DIRS, default: 'desc' })
  @IsOptional()
  @IsIn(DIRS)
  dir?: (typeof DIRS)[number];

  @ApiPropertyOptional({
    description: "Set to '1' to return every matching row (ignores limit/offset).",
  })
  @IsOptional()
  @Transform(({ value }) => value === '1' || value === 'true' || value === true)
  all?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  offset?: number;
}
