import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { RESTREAM_PLATFORMS, RestreamPlatform } from '../restream.presets';

/**
 * Body for POST /apps/:app/streams/:id/restream — add ONE forwarding
 * destination to a live stream. Either a preset platform + stream key, or
 * platform 'custom' + full rtmp(s):// URL.
 */
export class AddRestreamDto {
  @ApiPropertyOptional({
    enum: RESTREAM_PLATFORMS,
    default: 'custom',
    description:
      'Destination platform. Presets (youtube/twitch/facebook) build the push ' +
      'URL from their well-known ingest base + `key`; `custom` uses `url` as-is.',
  })
  @IsOptional()
  @IsIn(RESTREAM_PLATFORMS as readonly string[])
  platform?: RestreamPlatform;

  @ApiPropertyOptional({
    example: 'rtmp://ingest.example.com/live/my-stream-key',
    description:
      'Full RTMP/RTMPS destination URL (required for platform "custom").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(/^rtmps?:\/\/.+/i, {
    message: 'url must start with rtmp:// or rtmps://',
  })
  url?: string;

  @ApiPropertyOptional({
    example: 'abcd-efgh-ijkl-mnop',
    description:
      'Destination stream key (required for preset platforms). Stored ' +
      'server-side only; API responses always mask it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  key?: string;

  @ApiPropertyOptional({
    example: 'Canal principal de YouTube',
    description: 'Friendly label shown in listings.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: 'grid',
    description: 'Optional egress layout (e.g. "grid", "speaker").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  layout?: string;
}
