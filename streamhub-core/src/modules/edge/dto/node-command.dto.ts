import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';

/** Node commands the master can issue over the WS channel. */
export const NODE_COMMANDS = ['restart', 'reboot', 'ping'] as const;
export type NodeCommand = (typeof NODE_COMMANDS)[number];

/**
 * Body for `POST /edge/nodes/:id/command` — send an operational command to a
 * connected edge over the WS channel (audited). `restart` = the edge runtime
 * service; `reboot` = the host; `ping` = liveness round-trip.
 */
export class NodeCommandDto {
  @ApiProperty({ enum: NODE_COMMANDS, description: 'Command to run on the node.' })
  @IsIn(NODE_COMMANDS)
  command!: NodeCommand;

  @ApiPropertyOptional({
    description: 'Optional command arguments passed through to the edge runtime.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}
