import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query for GET /apps/:app/ingress — paging + basic filters. Values arrive as
 * strings; `@Type` coerces the numbers. Range-clamping (limit 1..500, offset
 * >= 0) happens in the controller, preserving clamp-not-reject behaviour.
 */
export class ListIngressDto {
  @ApiPropertyOptional({
    description: 'Room filter (bare name or already app-prefixed).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  room?: string;

  @ApiPropertyOptional({
    description: 'Free-text filter over ingress id / name / room.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 50 })
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
