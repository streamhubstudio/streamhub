import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /apps/:app/plugins/live-control/streams/:id/pause and .../finish.
 *
 * Every field is an OPTIONAL per-stream override of the app default. Omit them
 * all to pause/finish with the app's configured defaults. `assetId` selects an
 * uploaded cover asset (image/video); a text card uses cardTitle/cardText/color.
 */
export class CoverOverrideDto {
  @ApiPropertyOptional({
    enum: ['image', 'video', 'text'],
    description: 'Cover mode override. Omit → the app default mode.',
  })
  @IsOptional()
  @IsIn(['image', 'video', 'text'])
  mode?: 'image' | 'video' | 'text';

  @ApiPropertyOptional({
    description:
      'Id of an uploaded cover asset (image/video) to show. Omit → the app ' +
      "phase default. Ignored for a text card.",
  })
  @IsOptional()
  @IsInt()
  assetId?: number;

  @ApiPropertyOptional({ description: 'Text-card headline override.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cardTitle?: string;

  @ApiPropertyOptional({ description: 'Text-card body override.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cardText?: string;

  @ApiPropertyOptional({ description: 'Text-card background colour (#RRGGBB).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  cardColor?: string;
}
