import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateAppDto {
  @ApiProperty({ example: 'live', description: 'Unique app name (slug).' })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, {
    message: 'name must be a lowercase slug (a-z, 0-9, hyphen)',
  })
  name!: string;

  @ApiPropertyOptional({ example: 'Live' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ example: 'live' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  roomPrefix?: string;
}
