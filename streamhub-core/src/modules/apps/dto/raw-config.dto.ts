import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * Body for `PUT /apps/:app/config/raw` (wave-4 §1) — the full raw YAML of the
 * app's config.yaml. Validated (js-yaml parse + minimal shape) before it is
 * written; a parse/shape error returns 400 and the file is left untouched.
 */
export class PutRawConfigDto {
  @ApiProperty({
    description: 'Full raw config.yaml contents.',
    example: 'name: live\nroom_prefix: live\nrecording:\n  enabled: true\n',
  })
  @IsString()
  @MaxLength(100_000)
  yaml!: string;
}
