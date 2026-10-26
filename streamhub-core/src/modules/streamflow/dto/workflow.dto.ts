import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

/** Body of POST /apps/:app/plugins/streamflow/workflows. */
export class CreateWorkflowDto {
  @ApiProperty({ description: 'Workflow name.', example: 'Intrusion → AI → notify' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ description: 'Enabled (triggers active). Default true.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Graph: { boxes:[{id,type,config}], edges:[{from,fromPort?,to}] }.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  graph?: Record<string, unknown>;
}

/** Body of PUT /apps/:app/plugins/streamflow/workflows/:id. */
export class UpdateWorkflowDto {
  @ApiPropertyOptional({ description: 'New name.' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Enable/disable the workflow.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Replacement graph.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  graph?: Record<string, unknown>;
}

/** Body of POST /apps/:app/plugins/streamflow/workflows/:id/enable. */
export class EnableWorkflowDto {
  @ApiProperty({ description: 'Enabled flag.', example: true })
  @IsOptional()
  @IsBoolean()
  enabled!: boolean;
}

/** Body of POST /apps/:app/plugins/streamflow/workflows/import. */
export class ImportWorkflowDto {
  @ApiProperty({
    description: 'Portable workflow JSON: { streamflow, name, graph }.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  workflow!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Override the imported workflow name.' })
  @IsOptional()
  @IsString()
  name?: string;
}

/** Body of POST /apps/:app/plugins/streamflow/workflows/:id/run. */
export class ManualRunDto {
  @ApiPropertyOptional({
    description: 'Payload injected as the trigger payload (context.trigger).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

/** Body of PUT /apps/:app/plugins/streamflow/secrets/:name (write-only). */
export class PutSecretDto {
  @ApiProperty({
    description: 'Secret value (encrypted at rest; never returned by any GET).',
    example: 'sk-live-…',
  })
  @IsString()
  value!: string;
}
