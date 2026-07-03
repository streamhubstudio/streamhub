import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Body for POST /apps/:app/broadcast/start.
 *
 * The room must already exist and be published to (the browser connects +
 * publishes webcam/mic with a `canPublish` token BEFORE calling this); the
 * RoomComposite egress then renders the live room and pushes it to `rtmpUrl`.
 */
export class StartBroadcastDto {
  @ApiProperty({
    example: 'live-room-1',
    description: 'LiveKit room to broadcast (namespaced under the app prefix).',
  })
  @IsString()
  @MaxLength(200)
  roomName!: string;

  @ApiProperty({
    example: 'rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx-xxxx',
    description: 'Destination RTMP/RTMPS push URL (YouTube/Twitch/custom).',
  })
  @IsString()
  @MaxLength(2000)
  @Matches(/^rtmps?:\/\/.+/i, {
    message: 'rtmpUrl must start with rtmp:// or rtmps://',
  })
  rtmpUrl!: string;

  @ApiPropertyOptional({
    example: 'grid',
    description: 'Optional egress layout (e.g. "grid", "speaker").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  layout?: string;
}
