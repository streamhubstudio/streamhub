import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export enum IngressInputTypeDto {
  rtmp = 'rtmp',
  whip = 'whip',
  url = 'url',
  /** SRT push — passthrough (remux) plane ONLY: LiveKit's ingress API has no SRT input type. */
  srt = 'srt',
  /**
   * MPEG-TS over UDP (unicast + multicast) PULL — passthrough (remux) plane
   * ONLY. Not a client push: the remux connects OUT to a multicast group /
   * unicast port (`udp://@GROUP:PORT`) supplied in `url`. See
   * {@link MpegtsRequiresPassthroughMode}.
   */
  mpegts = 'mpegts',
}

/** Ingest mode for `POST /apps/:app/ingress`. */
export enum IngressModeDto {
  /** Normal LiveKit ingress (WebRTC + optional HLS). Default. */
  transcode = 'transcode',
  /** RTMP/SRT→HLS passthrough (remux, no transcode) — bypasses LiveKit. */
  passthrough = 'passthrough',
}

/**
 * Cross-field rule: `inputType: 'srt'` REQUIRES `mode: 'passthrough'`. LiveKit's
 * ingress API has no SRT input type (rtmp|whip|url only), so an SRT push can
 * only be served by the passthrough (remux) plane — anything else would land on
 * a LiveKit path that cannot take it. Explicit `mode: 'passthrough'` is required
 * (no silent default) so the caller consciously accepts the capabilities lost.
 * NB: to PULL from a remote SRT source via LiveKit, use
 * `{inputType:'url', url:'srt://…'}` instead (URL-pull, GStreamer srtsrc).
 */
@ValidatorConstraint({ name: 'srtRequiresPassthroughMode', async: false })
export class SrtRequiresPassthroughMode implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as CreateIngressDto;
    return (
      dto.inputType !== IngressInputTypeDto.srt ||
      dto.mode === IngressModeDto.passthrough
    );
  }
  defaultMessage(): string {
    return (
      "inputType 'srt' requires mode 'passthrough' — the LiveKit transcode path has " +
      "no SRT input type (to pull a remote SRT source, use inputType 'url' with an srt:// url)"
    );
  }
}

/**
 * Cross-field rule: `inputType: 'mpegts'` REQUIRES `mode: 'passthrough'`.
 * MPEG-TS-over-UDP only makes sense as a `-c copy` REMUX (multicast ingest is a
 * broadcast-contribution transport; there is no LiveKit ingress input for it and
 * transcoding a multicast source defeats the point). Explicit passthrough is
 * required so the caller consciously accepts the capabilities lost.
 */
@ValidatorConstraint({ name: 'mpegtsRequiresPassthroughMode', async: false })
export class MpegtsRequiresPassthroughMode
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as CreateIngressDto;
    return (
      dto.inputType !== IngressInputTypeDto.mpegts ||
      dto.mode === IngressModeDto.passthrough
    );
  }
  defaultMessage(): string {
    return (
      "inputType 'mpegts' requires mode 'passthrough' — MPEG-TS/UDP multicast is a " +
      'remux-only PULL ingest (there is no LiveKit transcode input for it)'
    );
  }
}

/**
 * Body for `POST /apps/:app/ingress` — create an RTMP/WHIP/URL/SRT/MPEG-TS
 * ingress that feeds a LiveKit room of the app (SPEC §6 per-app, §16 RTMP keys).
 * SRT and MPEG-TS are passthrough-only (see {@link SrtRequiresPassthroughMode},
 * {@link MpegtsRequiresPassthroughMode}).
 */
export class CreateIngressDto {
  @ApiProperty({
    enum: IngressInputTypeDto,
    example: 'rtmp',
    description:
      'rtmp = push URL+key; whip = WHIP endpoint; url = pull source (srt:// ' +
      'pull allowed); srt = SRT push listener — passthrough (remux) mode only; ' +
      'mpegts = MPEG-TS over UDP unicast/multicast PULL (url = udp://@GROUP:PORT) ' +
      '— passthrough (remux) mode only.',
  })
  @IsEnum(IngressInputTypeDto)
  @Validate(SrtRequiresPassthroughMode)
  @Validate(MpegtsRequiresPassthroughMode)
  inputType!: IngressInputTypeDto;

  @ApiPropertyOptional({
    enum: IngressModeDto,
    example: 'passthrough',
    description:
      'Ingest mode. `transcode` (default, or from app `rtmp.passthrough`) = normal ' +
      'LiveKit ingress. `passthrough` = REMUX the RTMP/SRT push straight to HLS ' +
      '(`ffmpeg -c copy`), bypassing LiveKit — no WebRTC/adaptive/recording. ' +
      'Passthrough is rtmp/srt-only and cannot be combined with adaptive/transcode; ' +
      'srt REQUIRES passthrough.',
  })
  @IsOptional()
  @IsEnum(IngressModeDto)
  mode?: IngressModeDto;

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
    description:
      'Required when inputType = url (a remote rtsp/http/srt source to pull via ' +
      'LiveKit) OR inputType = mpegts (a udp://@GROUP:PORT source to remux, e.g. ' +
      'udp://@239.1.1.1:5000 for multicast, udp://@:5000 for unicast). For mpegts ' +
      'the query params sources=/localaddr=/fifo_size=/overrun_nonfatal= are ' +
      'tolerated here and merged with the structured fields below.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional({
    example: '10.0.0.5',
    description:
      'MPEG-TS multicast only: source-specific multicast (SSM, IGMPv3) include ' +
      'list — a comma-separated list of source IPv4 addresses to receive from ' +
      '(ffmpeg `sources=`). Requires a multicast group host (224.0.0.0/4).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  sources?: string;

  @ApiPropertyOptional({
    example: '192.168.1.10',
    description:
      'MPEG-TS only: local interface (NIC) IPv4 to bind/join the group on, for ' +
      'multi-homed hosts (ffmpeg `localaddr=`).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(45)
  localaddr?: string;

  @ApiPropertyOptional({
    example: 1000000,
    description:
      'MPEG-TS only: ffmpeg `fifo_size` — the UDP receiving circular buffer size ' +
      'in units of 188-byte packets (ffmpeg default 28672 ≈ 5.4 MB). Raise it for ' +
      'bursty / high-bitrate multicast.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  fifoSize?: number;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'MPEG-TS only: ffmpeg `overrun_nonfatal` — survive a receiving-buffer ' +
      'overrun (drop packets) instead of aborting. Defaults ON so a transient ' +
      'burst never kills the remux.',
  })
  @IsOptional()
  @IsBoolean()
  overrunNonfatal?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Enable server-side transcoding (multi-layer). Required for rtmp/url; optional for whip. Defaults from app rtmp.transcode.',
  })
  @IsOptional()
  @IsBoolean()
  enableTranscoding?: boolean;

  @ApiPropertyOptional({
    example: true,
    default: false,
    deprecated: true,
    description:
      'DEPRECATED — LiveKit servers up to at least 1.8.4 IGNORE this flag, so ' +
      'it cannot reduce CPU; for a radio/audio channel use the passthrough mode ' +
      'instead ({mode:"passthrough"}, near-zero CPU). Kept for API back-compat: ' +
      'under the efficient ingest profile it still pins the single-layer preset ' +
      '(never the 3-layer default); under the livekit profile it is not forwarded.',
  })
  @IsOptional()
  @IsBoolean()
  audioOnly?: boolean;

  @ApiPropertyOptional({
    example: true,
    default: false,
    description:
      'RTMP only: also mint a BACKUP (failover) stream key bound to the SAME ' +
      'room. Both keys publish into one room, so the player/playback URL is ' +
      'unchanged whichever key is live. Point a redundant/failover encoder at ' +
      'the backup key and keep it on standby; if the primary drops, the backup ' +
      'keeps the channel alive with no URL change. Ignored for whip/url.',
  })
  @IsOptional()
  @IsBoolean()
  backup?: boolean;
}
