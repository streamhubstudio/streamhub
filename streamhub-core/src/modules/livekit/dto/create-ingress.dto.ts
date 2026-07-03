import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export enum IngressInputTypeDto {
  rtmp = 'rtmp',
  whip = 'whip',
  url = 'url',
}

/**
 * Body for `POST /apps/:app/ingress` — create an RTMP/WHIP/URL ingress that
 * feeds a LiveKit room of the app (SPEC §6 per-app, §16 RTMP keys).
 */
export class CreateIngressDto {
  @ApiProperty({
    enum: IngressInputTypeDto,
    example: 'rtmp',
    description: 'rtmp = push URL+key; whip = WHIP endpoint; url = pull source.',
  })
  @IsEnum(IngressInputTypeDto)
  inputType!: IngressInputTypeDto;

  @ApiPropertyOptional({
    example: 'demo',
    description:
      'Destination room. Namespaced with the app prefix if not already prefixed. Defaults to the app prefix.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-zA-Z0-9._\-]+$/, {
    message: 'room may only contain letters, numbers, dot, underscore, hyphen',
  })
  room?: string;

  @ApiPropertyOptional({
    example: 'rtmp-publisher',
    description: 'Participant identity for the ingress. Defaults to a generated id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  participantIdentity?: string;

  @ApiPropertyOptional({ example: 'RTMP source' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  participantName?: string;

  @ApiPropertyOptional({
    example: 'rtsp://camera.local/stream',
    description: 'Required when inputType = url. The remote source to pull.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Enable server-side transcoding (multi-layer). Required for rtmp/url; optional for whip. Defaults from app rtmp.transcode.',
  })
  @IsOptional()
  @IsBoolean()
  enableTranscoding?: boolean;
}
