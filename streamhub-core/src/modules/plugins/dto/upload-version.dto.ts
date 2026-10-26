import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Non-file fields of POST /plugins/:id/versions (multipart/form-data). The
 * gzip tarball itself rides as the `bundle` file part (read via FileInterceptor);
 * these are the accompanying text fields. `version` must be a valid semver — the
 * appstore rejects a non-semver or a `builtin-*` (reserved) value.
 */
export class UploadVersionDto {
  @ApiProperty({ description: 'Semver of the uploaded version.', example: '2.9.0' })
  @IsString()
  @MaxLength(64)
  version!: string;

  @ApiPropertyOptional({ description: 'Free-text note for this version.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
