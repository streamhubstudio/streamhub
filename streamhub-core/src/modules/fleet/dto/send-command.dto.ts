import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body of POST /apps/:app/plugins/fleet/command. */
export class SendCommandDto {
  @ApiProperty({ description: 'Target agent id.', example: 'b09994' })
  agentId!: string;

  @ApiProperty({
    description: 'Command name.',
    enum: ['restart', 'ota', 'config', 'ping'],
    example: 'ping',
  })
  command!: string;

  @ApiPropertyOptional({
    description:
      "Command args. ota → { url, version, sha256 }; config → { config: {…} }; " +
      'restart/ping → none.',
    type: 'object',
    additionalProperties: true,
  })
  args?: Record<string, unknown>;
}
