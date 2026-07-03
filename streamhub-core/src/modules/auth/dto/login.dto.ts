import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Request body of POST /auth/login. */
export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  user!: string;

  @ApiProperty({ example: 's3cret' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @ApiPropertyOptional({
    description:
      '6-digit TOTP code — required when the account has 2FA enabled ' +
      '(the API answers 401 `totp_required` without it).',
    example: '123456',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;
}
