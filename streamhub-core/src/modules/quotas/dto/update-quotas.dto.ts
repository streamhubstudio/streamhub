import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * Body for `PATCH /tenants/:id/quotas` — the platform owner (superadmin) raising
 * a tenant's plan label and/or per-metric limits from the Superadmin Tenants
 * screen. Every field is optional (patch just what changed); an empty body is a
 * no-op that returns the current tenant. `-1` means "unlimited" for any limit.
 * Validated by the global ValidationPipe; a bad field returns 400 and nothing
 * is written.
 */
export class UpdateQuotasDto {
  @ApiPropertyOptional({
    example: 'pro',
    description: 'Plan label stored on the tenant row. 1-64 chars.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  plan?: string;

  @ApiPropertyOptional({
    example: 10,
    description: 'Max apps the tenant may own. -1 = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1)
  maxApps?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Max concurrent live streams across the tenant. -1 = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1)
  maxConcurrentStreams?: number;

  @ApiPropertyOptional({
    example: 3000,
    description: 'Monthly recording-minutes budget. -1 = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1)
  maxRecordingMinutesMonth?: number;

  @ApiPropertyOptional({
    example: 100,
    description: 'Monthly egress budget in GB. -1 = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1)
  maxEgressGbMonth?: number;

  @ApiPropertyOptional({
    example: 100,
    description: 'Total storage budget in GB. -1 = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1)
  maxStorageGb?: number;
}
