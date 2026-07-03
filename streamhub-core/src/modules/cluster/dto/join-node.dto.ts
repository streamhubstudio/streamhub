import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIP,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /cluster/join` — an edge node registering itself with the
 * control plane (one-liner installer). Validated by the global ValidationPipe;
 * a bad field returns 400 and nothing is written.
 */
export class JoinNodeDto {
  @ApiProperty({
    example: 'edge-fra-1',
    description: 'Stable node name (also the upsert key). [a-zA-Z0-9._-], 1-64.',
  })
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'name may only contain a-z A-Z 0-9 . _ -',
  })
  name!: string;

  @ApiProperty({
    example: '203.0.113.10',
    description: 'The node public IP (IPv4 or IPv6).',
  })
  @IsString()
  @IsIP(undefined, { message: 'ip must be a valid IPv4 or IPv6 address' })
  ip!: string;

  @ApiPropertyOptional({ example: 'eu-central', description: 'Region label.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiPropertyOptional({
    example: 'https://edge-fra-1.example.com',
    description: 'Public URL of the node; falls back to `ip` when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  url?: string;
}
