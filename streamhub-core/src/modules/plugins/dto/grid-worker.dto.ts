import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /grid/workers` — a RESOLVED spawn spec the ORIGIN dispatched
 * to this node's grid agent (GRID-1). The plugin's `worker.spawn` closure is
 * already evaluated into command/args/env on the origin; the agent only spawns
 * + supervises. This is untrusted network input (gated by the cluster token),
 * so every field is length/shape-bounded.
 */
export class GridWorkerDto {
  @ApiProperty({ example: 'yolo', description: 'Plugin id (advisory label).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  pluginId!: string;

  @ApiProperty({ example: 'live', description: 'App slug (advisory label).' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  appName!: string;

  @ApiProperty({ example: 'python3', description: 'Executable to run.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  command!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['-m', 'yolo_worker', '--app', 'live'],
    description: 'Process arguments.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(256)
  args?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Environment variables (string→string). Includes the origin-facing ' +
      'STREAMHUB_INGEST_URL/TOKEN when the plugin feeds results back.',
  })
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Per-start ingest token (GRID-3) the worker echoes to the origin; also ' +
      'mirrored into STREAMHUB_INGEST_TOKEN if not already present in env.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  ingestToken?: string;
}
