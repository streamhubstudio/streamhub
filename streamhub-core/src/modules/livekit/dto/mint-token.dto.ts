import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /apps/:app/tokens` — mint a LiveKit join token for an app room
 * (SPEC §6 per-app, §10 player, §16 hidden QC). All fields optional; sensible
 * defaults are applied by the service (random identity, app room prefix, etc).
 */
export class MintTokenDto {
  @ApiPropertyOptional({
    example: 'demo',
    description:
      'Room name within the app. Namespaced with the app room prefix if not already prefixed. Defaults to the app prefix.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-zA-Z0-9._\-]+$/, {
    message: 'room may only contain letters, numbers, dot, underscore, hyphen',
  })
  room?: string;

  @ApiPropertyOptional({
    example: 'user-123',
    description: 'Participant identity. Defaults to a random identity.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  identity?: string;

  @ApiPropertyOptional({ example: 'Alice', description: 'Display name.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Allow publishing. Defaults to true.',
  })
  @IsOptional()
  @IsBoolean()
  canPublish?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Allow subscribing. Defaults to true.',
  })
  @IsOptional()
  @IsBoolean()
  canSubscribe?: boolean;

  @ApiPropertyOptional({
    example: '10m',
    description: 'Token TTL (zeit/ms span or seconds). Defaults to "6h".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  ttl?: string;

  @ApiPropertyOptional({
    description: 'Custom participant metadata (opaque string).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  metadata?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Hidden participant (QC/recorder): subscribes to all media but is invisible and not counted as a viewer. SPEC §16.',
  })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Mark token as a recorder/QC grant (roomRecord). Pairs with hidden. SPEC §16.',
  })
  @IsOptional()
  @IsBoolean()
  recorder?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Audio-only: restrict publishing to the microphone source (no camera/screenshare). Wave-4 §5/§6.',
  })
  @IsOptional()
  @IsBoolean()
  audioOnly?: boolean;
}
