import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Nested `logs` block of PUT /apps/:app/mqtt. */
export class SetMqttLogsDto {
  @ApiPropertyOptional({ description: 'Forward app logs over MQTT.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    example: 'info',
    description: 'Minimum forwarded level.',
  })
  @IsOptional()
  @IsIn(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  level?: string;
}

/** Nested `latencyAlert` block of PUT /apps/:app/mqtt. */
export class SetLatencyAlertDto {
  @ApiPropertyOptional({ description: 'Enable the stream latency monitor.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    example: 1000,
    description: 'Probe-RTT breach threshold in ms.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  thresholdMs?: number;

  @ApiPropertyOptional({
    example: 60,
    description: 'Minimum seconds between latency_high alerts per room.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cooldownSeconds?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Sampling interval in seconds (min 2).',
  })
  @IsOptional()
  @IsNumber()
  @Min(2)
  intervalSeconds?: number;
}

/**
 * Body for `PUT /apps/:app/mqtt`. The non-secret fields are written to
 * config.yaml; `password` goes to data/secrets.json (chmod 600), never the
 * yaml (same pattern as the S3 credentials). Omit `password` to keep the
 * stored one. After persisting, the app's live MQTT client is dropped so the
 * next publish reconnects with the new settings.
 */
export class SetMqttDto {
  @ApiPropertyOptional({ description: 'Master switch.', example: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Broker URL: mqtt:// | mqtts:// | ws:// | wss:// (path allowed, e.g. wss://mqtt.example.com/mqtt).',
    example: 'mqtt://127.0.0.1:1883',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  url?: string;

  @ApiPropertyOptional({ example: 'streamhub' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @ApiPropertyOptional({
    description: 'Broker password — stored in secrets.json, never the yaml.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  @ApiPropertyOptional({
    description: 'Topic root. Empty = streamhub/<app>.',
    example: 'streamhub/live',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  topicPrefix?: string;

  @ApiPropertyOptional({ enum: [0, 1, 2], example: 0 })
  @IsOptional()
  @IsInt()
  @IsIn([0, 1, 2])
  qos?: number;

  @ApiPropertyOptional({
    description: 'Force TLS (mqtt:// upgraded to mqtts://).',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  tls?: boolean;

  @ApiPropertyOptional({
    description: "Event filter: ['all'] or explicit event names.",
    example: ['all'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  events?: string[];

  @ApiPropertyOptional({ type: SetMqttLogsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SetMqttLogsDto)
  logs?: SetMqttLogsDto;

  @ApiPropertyOptional({ type: SetLatencyAlertDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SetLatencyAlertDto)
  latencyAlert?: SetLatencyAlertDto;
}
