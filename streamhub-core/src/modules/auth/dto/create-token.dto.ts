import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTokenDto {
  @ApiProperty({ example: 'ui-server' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: ['global', 'app'], example: 'global' })
  @IsIn(['global', 'app'])
  scope!: 'global' | 'app';

  @ApiPropertyOptional({ description: 'Required when scope=app.' })
  @IsOptional()
  @IsInt()
  appId?: number;

  @ApiPropertyOptional({ type: [String], example: ['127.0.0.1'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedIps?: string[];
}
