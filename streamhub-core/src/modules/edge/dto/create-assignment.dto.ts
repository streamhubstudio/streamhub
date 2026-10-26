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
 * Body for `POST /edge/assignments` — schedule a worker workload (app × plugin,
 * optionally scoped to a stream) onto an edge node. The scheduler picks the node
 * and pushes it over the WS channel; `config` is the plugin's user config.
 */
export class CreateAssignmentDto {
  @ApiProperty({ example: 'live', description: 'Tenant app (slug) the worker runs for.' })
  @IsString()
  @Matches(SLUG, { message: 'app must be a slug' })
  app!: string;

  @ApiProperty({ example: 'yolo', description: 'Plugin id whose worker to run.' })
  @IsString()
  @Matches(SLUG, { message: 'pluginId must be a slug' })
  pluginId!: string;

  @ApiPropertyOptional({
    example: 'cam1/wscam-abc',
    description: 'Optional stream id to scope the worker to (app-wide when omitted).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  streamId?: string;

  @ApiPropertyOptional({
    description: 'Validated plugin config for this workload (defaults filled by the plugin).',
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
