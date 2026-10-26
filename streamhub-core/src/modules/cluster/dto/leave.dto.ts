import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for `POST /cluster/leave` — revert this node to standalone. The local
 * role flip always happens; `masterToken` (the master's global Bearer token) is
 * OPTIONAL and only used for the best-effort `DELETE /cluster/nodes/:id`
 * de-register at the master (that endpoint is global-scoped, so without it the
 * node is left in the master registry for the operator to remove).
 */
export class LeaveDto {
  @ApiPropertyOptional({
    description:
      "The master's global Bearer token (sk_…) for the best-effort de-register.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  masterToken?: string;
}
