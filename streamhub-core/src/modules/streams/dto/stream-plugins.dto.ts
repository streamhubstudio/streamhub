import { ArrayUnique, IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of PATCH /apps/:app/streams/:id/plugins. Replaces the stream's
 * opted-OUT plugin id list (a stream is affected by every app-enabled plugin
 * NOT in this array). Duplicates are rejected; the service also normalizes.
 */
export class StreamPluginsDto {
  @ApiProperty({
    description: 'Plugin ids this stream is opted OUT of (disabled).',
    type: [String],
    example: ['watermark'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  disabled!: string[];
}
