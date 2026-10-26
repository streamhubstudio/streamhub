import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidateNested,
} from 'class-validator';
import { isValidTimezone } from '../../../shared/timezone.util';

/**
 * `timezone` must be empty (server default) or a real IANA zone name —
 * validated against `Intl.supportedValuesOf('timeZone')` (fallback list if
 * unavailable), see `shared/timezone.util.ts`.
 */
@ValidatorConstraint({ name: 'isIanaTimezoneOrEmpty', async: false })
export class IsIanaTimezoneOrEmpty implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments): boolean {
    return typeof value === 'string' && isValidTimezone(value.trim());
  }
  defaultMessage(): string {
    return 'timezone must be empty (server default) or a valid IANA zone name (e.g. America/Argentina/Buenos_Aires)';
  }
}

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

  @ApiPropertyOptional({
    example: 'America/Argentina/Buenos_Aires',
    description:
      'Per-app IANA timezone. Used to render app-scoped dashboard timestamps ' +
      "(logs, streams, VODs, backups…) and as the DEFAULT for any plugin/" +
      "schedule config that leaves its own timezone empty (an explicit " +
      "plugin-level timezone always wins). Empty string = server/host local " +
      'time (the pre-existing default).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Validate(IsIanaTimezoneOrEmpty)
  timezone?: string;

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

  @ApiPropertyOptional({
    description:
      'Filename/S3-key template for recordings (StoreHub-style `${}` dialect: ' +
      '${app} ${streamId} ${room} ${type} ${ts} ${date:yyyy-MM-dd} ${var.NAME}). ' +
      'Empty = built-in naming. Rendered to one safe segment (no path traversal).',
    example: '${app}_${room}_${date:yyyyMMdd-HHmmss}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  filenameTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Filename/S3-key template for snapshots (same dialect; ${type} = jpg). ' +
      'Empty = built-in naming.',
    example: '${room}_snap_${date:yyyyMMdd-HHmmss}',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  snapshotTemplate?: string;

  @ApiPropertyOptional({
    description:
      'VOD retention window in DAYS. 0 = OFF (keep forever). A periodic janitor ' +
      'deletes VODs older than the window from the app DB AND the app S3 storage.',
    enum: [0, 7, 30, 90, 180, 360],
    example: 30,
  })
  @IsOptional()
  @IsIn([0, 7, 30, 90, 180, 360], {
    message: 'retentionDays must be one of 0,7,30,90,180,360',
  })
  retentionDays?: number;

  @ApiPropertyOptional({
    description:
      'RTMP→HLS passthrough (remux, no transcode). true REMUXES RTMP straight to ' +
      'HLS bypassing LiveKit (near-zero CPU); MUTUALLY EXCLUSIVE with ' +
      'transcode/adaptive (enabling it forces those off, and vice-versa).',
  })
  @IsOptional()
  @IsBoolean()
  rtmpPassthrough?: boolean;

  @ApiPropertyOptional({
    description:
      'Resolution cap (px height) for the transcoded RTMP/URL ingress. Bounds ' +
      'the ingress transcode CPU: a single-layer ingest re-encodes to this ' +
      'height, an adaptive ingest caps its top ladder layer here. Default 720.',
    enum: [360, 480, 720, 1080],
    example: 720,
  })
  @IsOptional()
  @IsIn([360, 480, 720, 1080], {
    message: 'transcodeMaxHeight must be one of 360,480,720,1080',
  })
  transcodeMaxHeight?: number;

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

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Per-app plain-config VARIABLES (whole-map REPLACE) referenced from ' +
      'filename/S3-key templates as ${var.NAME}. Keys must be [A-Za-z0-9_]; ' +
      'values are strings. NOT secrets — plain config, returned by GET config.',
    example: { site: 'HQ', channel: 'main' },
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
