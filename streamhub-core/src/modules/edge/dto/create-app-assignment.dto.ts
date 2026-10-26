import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Body for `POST /apps/:app/edge/assignments` — schedule an edge-capable
 * plugin's worker onto an edge node, scoped to the app in the path. The plugin
 * must be INSTALLED in the app and its meta must declare `worker.edge === true`
 * (validated in the controller). `config` overrides/augments the install config
 * for this workload (e.g. `{ room }`); the scheduler picks the node and pushes
 * it over the WS channel.
 */
export class CreateAppAssignmentDto {
  @ApiProperty({ example: 'lpr', description: 'Edge-capable plugin id to run.' })
  @IsString()
  @Matches(SLUG, { message: 'pluginId must be a slug' })
  pluginId!: string;

  @ApiPropertyOptional({
    example: 'gate-cam',
    description: 'Stream / room id to scope the worker to (app-wide when omitted).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  streamId?: string;

  @ApiPropertyOptional({
    description: 'Config for this workload (merged over the install config by the caller).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: ['round_robin', 'weighted'],
    description: 'Override the instance default placement policy for this assignment.',
  })
  @IsOptional()
  @IsIn(['round_robin', 'weighted'])
  policy?: 'round_robin' | 'weighted';
}
