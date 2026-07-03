import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /apps/:app/streams/:id/data` — relay a server-side data
 * message over LiveKit data channels (SPEC §16 chat/reactions). Transport is
 * client-side; the core only injects the message and fires outbound callbacks.
 */
export class SendDataDto {
  @ApiProperty({
    example: 'chat',
    description:
      'Data topic. `chat`/`reaction` map to the chat_message/reaction callbacks.',
  })
  @IsString()
  @MaxLength(64)
  topic!: string;

  @ApiPropertyOptional({
    example: 'hello world',
    description: 'Convenience text message (chat). Mutually fine with `payload`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  @ApiPropertyOptional({
    example: '❤️',
    description: 'Reaction emoji/identifier for topic = reaction.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reaction?: string;

  @ApiPropertyOptional({
    description:
      'Raw payload to broadcast. When omitted, an envelope is built from message/reaction.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  payload?: string;

  @ApiPropertyOptional({ example: 'user-123', description: 'Sender identity.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  from?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Restrict delivery to these participant identities.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  destinationIdentities?: string[];

  @ApiPropertyOptional({
    example: true,
    description: 'Reliable delivery (default true). false = lossy.',
  })
  @IsOptional()
  @IsBoolean()
  reliable?: boolean;
}

/** Body for `POST /apps/:app/ingress/:id/validate` — RTMP password check. */
export class ValidateIngressPasswordDto {
  @ApiProperty({ example: 's3cr3t', description: 'Stream password to verify.' })
  @IsString()
  @MaxLength(256)
  password!: string;
}
