import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Node kinds the scheduler distinguishes (see `nodes.type`). */
export const EDGE_NODE_TYPES = ['common', 'edge'] as const;
export type EdgeNodeType = (typeof EDGE_NODE_TYPES)[number];

/**
 * Body for `PATCH /edge/nodes/:id` — an operator retyping a node (`common`↔`edge`)
 * or setting its scheduling `weight` (share for the weighted policy). Empty body
 * is a no-op returning the current row.
 */
export class PatchEdgeNodeDto {
  @ApiPropertyOptional({
    enum: EDGE_NODE_TYPES,
    description: "Node kind: 'edge' (worker/compute) or 'common' (full media node).",
  })
  @IsOptional()
  @IsIn(EDGE_NODE_TYPES)
  type?: EdgeNodeType;

  @ApiPropertyOptional({
    example: 100,
    minimum: 0,
    maximum: 100000,
    description: 'Relative scheduling weight (share ∝ weight/Σweights) for the weighted policy.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  weight?: number;
}
