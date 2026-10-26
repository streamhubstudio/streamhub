import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import {
  MAX_PLAYBACK_TTL_S,
  MIN_PLAYBACK_TTL_S,
} from '../playback-url.util';

/**
 * Body for `POST /apps/:app/play-token/:room/sign` (security fix P0-3) —
 * mint a signed, short-TTL playback URL for a private-playback app.
 */
export class SignPlaybackUrlDto {
  @ApiPropertyOptional({
    example: 300,
    description: `Signed URL lifetime in seconds (default 300, ${MIN_PLAYBACK_TTL_S}–${MAX_PLAYBACK_TTL_S}).`,
    minimum: MIN_PLAYBACK_TTL_S,
    maximum: MAX_PLAYBACK_TTL_S,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_PLAYBACK_TTL_S)
  @Max(MAX_PLAYBACK_TTL_S)
  ttlSeconds?: number;
}
