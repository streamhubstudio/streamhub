import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /cluster/heartbeat` — an already-joined node reporting it is
 * alive. The `nodeId` is the value returned by `POST /cluster/join`.
 */
export class HeartbeatDto {
  @ApiProperty({
    example: '4b2f0c2e-1a3d-4c5e-8f9a-0b1c2d3e4f5a',
    description: 'The node id handed back by /cluster/join.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  nodeId!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Free-form node stats (e.g. cpu, mem, activeStreams). Persisted verbatim ' +
      'in the registry (last-write-wins) and capped at ~4KB serialized (413/400 ' +
      'over the limit). Omit to send a bare liveness ping.',
  })
  @IsOptional()
  @IsObject()
  stats?: Record<string, unknown>;
}
