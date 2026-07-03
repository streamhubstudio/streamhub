import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AppFeaturesDto } from '../../apps/dto/update-app-config.dto';
import { HwaccelMode } from '../../system/gpu.types';

/**
 * One WebRTC rendition layer (SPEC §7 webrtc.layers). E.g. { name: 'high',
 * height: 720 }. Width is derived by LiveKit from the source aspect ratio.
 */
export class WebrtcLayerDto {
  @ApiProperty({ example: 'high', description: 'Layer label.' })
  @IsString()
  @Matches(/^[a-z0-9_-]{1,20}$/, {
    message: 'name must be a short lowercase slug (a-z, 0-9, _ , -)',
  })
  name!: string;

  @ApiProperty({ example: 720, description: 'Target height in pixels.' })
  @IsInt()
  @Min(1)
  @Max(4320)
  height!: number;
}

/**
 * One VOD rendition of the adaptive ladder (`transcoding.vod_renditions`).
 * `bitrateKbps` is the H.264 video bitrate target for that height.
 */
export class VodRenditionDto {
  @ApiProperty({ example: 720, description: 'Target height in pixels.' })
  @IsInt()
  @Min(144)
  @Max(4320)
  height!: number;

  @ApiProperty({ example: 2800, description: 'Video bitrate target (kbps).' })
  @IsInt()
  @Min(100)
  @Max(50000)
  bitrateKbps!: number;
}

/**
 * Partial update of an app's adaptive/transcoding config (SPEC §5 transcoding,
 * §7 webrtc/rtmp). Only the fields owned by the transcoding module are exposed
 * here; everything is optional so callers PATCH just what changed.
 */
export class UpdateTranscodingConfigDto {
  @ApiPropertyOptional({
    description: 'Enable adaptive (simulcast) WebRTC delivery.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  adaptive?: boolean;

  @ApiPropertyOptional({
    type: [WebrtcLayerDto],
    description: 'Rendition ladder (e.g. 720/480/240). Replaces the full ladder.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => WebrtcLayerDto)
  layers?: WebrtcLayerDto[];

  @ApiPropertyOptional({
    description: 'Transcode RTMP ingress to a multi-layer ladder.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  rtmpTranscode?: boolean;

  @ApiPropertyOptional({
    type: AppFeaturesDto,
    description: 'Wave-2 feature flags (SPEC §16).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AppFeaturesDto)
  features?: AppFeaturesDto;

  @ApiPropertyOptional({
    enum: ['auto', 'gpu', 'cpu'],
    description:
      "GPU hardware-transcoding preference (SPEC §5). 'auto' (default) uses " +
      "the GPU when the node has one, else CPU; 'gpu' forces GPU (falls back " +
      "to CPU if none); 'cpu' always uses software.",
    example: 'auto',
  })
  @IsOptional()
  @IsIn(['auto', 'gpu', 'cpu'])
  hwaccel?: HwaccelMode;

  @ApiPropertyOptional({
    description:
      'Master switch for server-side transcoding (config.yaml ' +
      '`transcoding.enabled`). Default false on new apps: pure passthrough — ' +
      'RTMP ingress is not re-encoded and recordings stay single-file H.264. ' +
      'Must be true for rtmpTranscode / encoding / vodAdaptive to take effect.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  transcodingEnabled?: boolean;

  @ApiPropertyOptional({
    enum: ['h264', 'h264+vp8'],
    description:
      "Recording output encoding target: 'h264' (MP4 only, egress-native) or " +
      "'h264+vp8' (also generate a WebM/VP8 alternate via ffmpeg post-transcode).",
    example: 'h264',
  })
  @IsOptional()
  @IsIn(['h264', 'h264+vp8'])
  encoding?: 'h264' | 'h264+vp8';

  @ApiPropertyOptional({
    description:
      'Generate an adaptive HLS VOD per recording: a master playlist + one ' +
      'rendition per ladder step (ffmpeg post-transcode, stored as VOD variants).',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  vodAdaptive?: boolean;

  @ApiPropertyOptional({
    type: [VodRenditionDto],
    description:
      'Explicit VOD rendition ladder (replaces the whole list). Empty/omitted ' +
      '= derive from webrtc.layers heights with default per-height bitrates.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => VodRenditionDto)
  vodRenditions?: VodRenditionDto[];
}
