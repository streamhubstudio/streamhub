import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Request body of POST /auth/magic/verify — the one-time token from the link. */
export class MagicVerifyDto {
  @ApiProperty({
    description: 'The one-time token from the emailed magic link.',
    example: 'kJ3v...base64url',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  token!: string;

  @ApiPropertyOptional({
    description:
      '6-digit TOTP code — required when the account has 2FA enabled ' +
      '(the API answers 401 `totp_required` without it; the link is NOT burnt).',
    example: '123456',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;
}
