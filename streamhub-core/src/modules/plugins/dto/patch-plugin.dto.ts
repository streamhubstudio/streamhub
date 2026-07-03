import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of PATCH /apps/:app/plugins/:id. Both fields optional; `config` is a
 * free-form object validated at runtime against the plugin's configSchema (the
 * schema is per-plugin, so it can't be a static class-validator shape).
 */
export class PatchPluginDto {
  @ApiPropertyOptional({ description: 'Enable/disable the installed plugin.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Partial config; keys/values validated against the plugin configSchema.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
