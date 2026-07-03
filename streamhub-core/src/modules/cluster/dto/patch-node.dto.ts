import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/** The administrative states a node can be pinned to via PATCH /cluster/nodes/:id. */
export const NODE_STATUSES = ['active', 'draining', 'disabled'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Body for `PATCH /cluster/nodes/:id` — an operator editing a registered node
 * from the dashboard cluster manager. Every field is optional (patch just what
 * changed); an empty body is a no-op that returns the current row. Validated by
 * the global ValidationPipe; a bad field returns 400 and nothing is written.
 */
export class PatchNodeDto {
  @ApiPropertyOptional({
    example: 'edge-fra-1',
    description: 'Rename the node. [a-zA-Z0-9._-], 1-64.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'name may only contain a-z A-Z 0-9 . _ -',
  })
  name?: string;

  @ApiPropertyOptional({ example: 'eu-central', description: 'Region label.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiPropertyOptional({
    enum: NODE_STATUSES,
    example: 'draining',
    description:
      "Administrative state: 'active' (serving), 'draining' (finish in-flight, " +
      "take no new work) or 'disabled' (parked).",
  })
  @IsOptional()
  @IsIn(NODE_STATUSES)
  status?: NodeStatus;
}
