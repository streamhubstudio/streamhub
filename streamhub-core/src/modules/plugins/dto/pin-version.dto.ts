import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Body of PUT /apps/:app/plugins/:id/version. `version` is the exact appstore
 * version to pin, or `null` to UNPIN (built-in/latest). Omitting it is treated
 * as null (unpin) by the controller.
 */
export class PinVersionDto {
  @ApiPropertyOptional({
    description:
      'Exact appstore version to pin (e.g. 2.9.0), or null to unpin (built-in).',
    nullable: true,
    example: '2.9.0',
  })
  // Skip the string check when the caller explicitly sends null (= unpin).
  @ValidateIf((o) => o.version !== null && o.version !== undefined)
  @IsString()
  @MaxLength(64)
  version?: string | null;
}
