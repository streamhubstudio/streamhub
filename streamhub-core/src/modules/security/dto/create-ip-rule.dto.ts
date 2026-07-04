import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of POST /security/ip-rules. */
export class CreateIpRuleDto {
  @ApiProperty({
    description:
      'IPv4/IPv6 CIDR (a.b.c.d/nn, 2001:db8::/32) or a bare IP (implied /32 or /128).',
    example: '203.0.113.0/24',
  })
  @IsString()
  @MaxLength(64)
  cidr!: string;

  @ApiProperty({ enum: ['allow', 'block'] })
  @IsIn(['allow', 'block'])
  action!: 'allow' | 'block';

  @ApiPropertyOptional({ description: 'Free-form operator note.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
