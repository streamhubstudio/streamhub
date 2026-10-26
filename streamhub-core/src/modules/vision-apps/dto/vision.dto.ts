import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

/**
 * Body for `PUT /apps/:app/plugins/:visionApp/streams/:room/settings`.
 * `config` is the per-model `config_json` (polygons / lines / ROI) — validated
 * + normalized by `validateModelSettings`, so `IsObject` is enough here.
 */
export class PutStreamSettingsDto {
  @ApiPropertyOptional({
    description: 'Per-model config_json (zones / lines / roi). Defaults to {}.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
