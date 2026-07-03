import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Wave-2 per-app feature flags (SPEC §16). All optional booleans. */
export class AppFeaturesDto {
  @ApiPropertyOptional({ description: 'Require a password besides the RTMP key.' })
  @IsOptional()
  @IsBoolean()
  rtmpPassword?: boolean;

  @ApiPropertyOptional({ description: 'Expose a live subscriber count.' })
  @IsOptional()
  @IsBoolean()
  viewerCounter?: boolean;

  @ApiPropertyOptional({ description: 'Enable data-channel chat.' })
  @IsOptional()
  @IsBoolean()
  chat?: boolean;

  @ApiPropertyOptional({ description: 'Enable animated reactions.' })
  @IsOptional()
  @IsBoolean()
  reactions?: boolean;

  @ApiPropertyOptional({ description: 'Allow hidden QC/recorder participants.' })
  @IsOptional()
  @IsBoolean()
  hiddenQc?: boolean;

  @ApiPropertyOptional({ description: 'Adaptive player (simulcast + transcode).' })
  @IsOptional()
  @IsBoolean()
  adaptivePlayer?: boolean;

  @ApiPropertyOptional({
    description: 'Allow anonymous public playback (play-token, /play, /embed).',
  })
  @IsOptional()
  @IsBoolean()
  publicPlayback?: boolean;
}

/**
 * Partial config.yaml patch (SPEC §7). Flat shape of the most-edited fields;
 * the controller maps it into a structured Partial<AppConfig>. Secret S3
 * credentials are intentionally NOT accepted here (they go through the
 * s3/auth modules into data/secrets.json, never the versionable yaml).
 */
export class UpdateAppConfigDto {
  @ApiPropertyOptional({ example: 'Live' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ example: 'live', description: 'LiveKit room prefix.' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,39}$/, {
    message: 'roomPrefix must be a lowercase slug (a-z, 0-9, hyphen)',
  })
  roomPrefix?: string;

  @ApiPropertyOptional({ description: 'Enable/disable recording for the app.' })
  @IsOptional()
  @IsBoolean()
  recordingEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Split the recording into N-minute MP4 parts (each part = its own VOD). ' +
      '0 = continuous single file.',
    enum: [0, 15, 30, 60, 90, 120],
    example: 30,
  })
  @IsOptional()
  @IsIn([0, 15, 30, 60, 90, 120], {
    message: 'splitMinutes must be one of 0,15,30,60,90,120',
  })
  splitMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Capture a JPEG snapshot every N seconds during the recording. 0 = off.',
    enum: [0, 1, 30, 60, 120, 360],
    example: 60,
  })
  @IsOptional()
  @IsIn([0, 1, 30, 60, 120, 360], {
    message: 'snapshotSeconds must be one of 0,1,30,60,120,360',
  })
  snapshotSeconds?: number;

  @ApiPropertyOptional({ description: 'Outbound callback URL.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  callbackUrl?: string;

  @ApiPropertyOptional({ description: 'Shared secret used to sign callbacks.' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  callbackSecret?: string;

  @ApiPropertyOptional({
    type: AppFeaturesDto,
    description: 'Wave-2 feature flags (SPEC §16).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AppFeaturesDto)
  features?: AppFeaturesDto;
}
