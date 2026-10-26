import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * DTOs for the per-app rooms API (`/apps/:app/rooms/...`): room & participant
 * metadata plus server-side moderation (kick / mute / force-subscriptions)
 * over the native LiveKit RoomServiceClient calls.
 */

/** Body for `PATCH /apps/:app/rooms/:room/metadata`. */
export class UpdateRoomMetadataDto {
  @ApiProperty({
    example: '{"onAir":true,"title":"Morning show"}',
    description:
      'Opaque metadata string attached to the live room (typically JSON). ' +
      'Connected clients receive `roomMetadataChanged`.',
  })
  @IsString()
  @MaxLength(10_000)
  metadata!: string;
}

/** Body for `PATCH /apps/:app/rooms/:room/participants/:identity`. */
export class UpdateParticipantDto {
  @ApiPropertyOptional({
    example: '{"role":"speaker"}',
    description:
      'Opaque participant metadata (typically JSON). Clients receive ' +
      '`participantMetadataChanged`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  metadata?: string;

  @ApiPropertyOptional({ example: 'Jane', description: 'Display name.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Allow publishing media.' })
  @IsOptional()
  @IsBoolean()
  canPublish?: boolean;

  @ApiPropertyOptional({ description: 'Allow subscribing to tracks.' })
  @IsOptional()
  @IsBoolean()
  canSubscribe?: boolean;

  @ApiPropertyOptional({ description: 'Allow publishing data messages.' })
  @IsOptional()
  @IsBoolean()
  canPublishData?: boolean;
}

/** Body for `POST /apps/:app/rooms/:room/participants/:identity/mute`. */
export class MuteParticipantDto {
  @ApiPropertyOptional({
    example: 'TR_xxxx',
    description:
      'Track sid to mute. When omitted, `kind` selects the tracks to mute.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  trackSid?: string;

  @ApiPropertyOptional({
    enum: ['audio', 'video', 'all'],
    description:
      "Which published tracks to mute when no trackSid is given. Default 'all'.",
  })
  @IsOptional()
  @IsIn(['audio', 'video', 'all'])
  kind?: 'audio' | 'video' | 'all';

  @ApiPropertyOptional({
    example: true,
    description: 'true = mute (default), false = unmute.',
  })
  @IsOptional()
  @IsBoolean()
  muted?: boolean;
}

/** Body for `POST /apps/:app/rooms/:room/participants/:identity/subscriptions`. */
export class UpdateSubscriptionsDto {
  @ApiProperty({
    type: [String],
    example: ['TR_aaaa', 'TR_bbbb'],
    description: 'Track sids to (un)subscribe the participant to.',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  trackSids!: string[];

  @ApiProperty({
    example: true,
    description: 'true = force-subscribe, false = force-unsubscribe.',
  })
  @IsBoolean()
  subscribe!: boolean;
}
