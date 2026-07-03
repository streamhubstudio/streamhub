import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body for `PUT /apps/:app/s3` (wave-4 §2). The non-secret fields are written to
 * config.yaml; `key`/`secret` go to data/secrets.json (chmod 600), never the
 * yaml. After persisting, the app's S3 client is re-initialized.
 */
export class SetS3Dto {
  @ApiPropertyOptional({ enum: ['aws', 'wasabi', 'minio'], example: 'wasabi' })
  @IsOptional()
  @IsIn(['aws', 'wasabi', 'minio'])
  provider?: 'aws' | 'wasabi' | 'minio';

  @ApiPropertyOptional({ example: 'my-bucket' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  bucket?: string;

  @ApiPropertyOptional({ example: 'us-east-1' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiPropertyOptional({ example: 'https://s3.us-east-1.wasabisys.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  endpoint?: string;

  @ApiPropertyOptional({
    description: 'Path-style addressing (true for MinIO).',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  forcePathStyle?: boolean;

  @ApiPropertyOptional({ example: 'streamhub/live' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  prefix?: string;

  @ApiPropertyOptional({
    description:
      'Public/CDN base URL for objects. When set, VOD URLs are <public_url>/<key>.',
    example: 'https://cdn.example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public_url?: string;

  @ApiPropertyOptional({
    description: 'S3 access key — stored in secrets.json, never the yaml.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  key?: string;

  @ApiPropertyOptional({
    description: 'S3 secret key — stored in secrets.json, never the yaml.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  secret?: string;

  @ApiPropertyOptional({
    description:
      'Fold-3: required (true) to ENABLE a non-empty public_url — this makes ' +
      'recordings publicly accessible (not presigned). Not needed to clear it.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  confirmPublic?: boolean;
}
