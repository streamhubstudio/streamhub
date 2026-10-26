import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIP,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Body for `POST /cluster/join-master` — convert THIS node into an edge of a
 * remote master. The server calls the master's `POST /cluster/join` with the
 * supplied `clusterToken` (X-Cluster-Token) on the operator's behalf.
 */
export class JoinMasterDto {
  @ApiProperty({
    example: 'https://master.example.com',
    description: 'API base URL of the cluster master.',
  })
  @IsString()
  // Allow http (installer default) + no-TLD hosts (localhost / bare IP).
  @IsUrl(
    { protocols: ['http', 'https'], require_tld: false, require_protocol: true },
    { message: 'masterUrl must be an http(s) URL' },
  )
  @MaxLength(255)
  masterUrl!: string;

  @ApiProperty({
    description: "The master's STREAMHUB_CLUSTER_TOKEN (sent as X-Cluster-Token).",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  clusterToken!: string;

  @ApiProperty({
    example: 'edge-fra-1',
    description: 'Stable name for this node in the master registry. [a-zA-Z0-9._-], 1-64.',
  })
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'nodeName may only contain a-z A-Z 0-9 . _ -',
  })
  nodeName!: string;

  @ApiPropertyOptional({ example: 'eu-central', description: 'Region label.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiPropertyOptional({
    example: '203.0.113.10',
    description: 'This node public IP reported to the master. Auto-detected when omitted.',
  })
  @IsOptional()
  @IsString()
  @IsIP(undefined, { message: 'nodeIp must be a valid IPv4 or IPv6 address' })
  nodeIp?: string;

  @ApiPropertyOptional({
    example: 'https://edge-fra-1.example.com',
    description: 'Public URL of this node (falls back to nodeIp at the master).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nodeUrl?: string;
}
