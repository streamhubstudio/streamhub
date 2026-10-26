import {
  ArrayUnique,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Body of POST /apps/:app/tags — create a tag. */
export class CreateTagDto {
  @ApiProperty({
    description: 'Stable kebab-case reference stored on streams.',
    example: 'store-downtown',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be kebab-case (lowercase a-z, 0-9, hyphen-separated)',
  })
  slug!: string;

  @ApiProperty({ description: 'Human-readable label.', example: 'Downtown Store' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({
    description: "Tag kind (e.g. 'store' | 'zone' | 'custom'). Default 'custom'.",
    example: 'store',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  kind?: string;

  @ApiPropertyOptional({
    description:
      "Settings blob for this tag (schema owned by the tag's consumer, e.g. " +
      'per-model vision settings).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config_json?: Record<string, unknown>;
}

/** Body of PATCH /apps/:app/tags/:slug — partial update (slug is immutable). */
export class UpdateTagDto {
  @ApiPropertyOptional({ description: 'Human-readable label.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: "Tag kind (e.g. 'store' | 'zone' | 'custom')." })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  kind?: string;

  @ApiPropertyOptional({
    description: 'Settings blob for this tag (replaces the stored config).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config_json?: Record<string, unknown>;
}

/**
 * Body of PATCH /apps/:app/streams/:id/tags and PATCH /apps/:app/tags/room/:room.
 * Replaces the applied tag slugs. Every slug must reference an existing tag.
 */
export class ApplyTagsDto {
  @ApiProperty({
    description: 'Tag slugs to apply (must all exist).',
    type: [String],
    example: ['store-downtown', 'zone-entrance'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  tags!: string[];
}
