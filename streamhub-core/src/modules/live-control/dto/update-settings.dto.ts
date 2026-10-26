import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional } from 'class-validator';

/**
 * Body for PUT /apps/:app/plugins/live-control/settings — the per-app DYNAMIC
 * defaults that reference an uploaded asset id (the static behavioural defaults
 * live in the plugin config schema). Send `null` to clear a default.
 */
export class UpdateSettingsDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Default cover asset id used when a stream is PAUSED with no override.',
  })
  @IsOptional()
  @IsInt()
  defaultPauseAssetId?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Default cover asset id used when a stream is FINISHED with no override.',
  })
  @IsOptional()
  @IsInt()
  defaultFinishAssetId?: number | null;
}
