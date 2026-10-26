import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Request body of PATCH /account — partial profile update. */
export class UpdateAccountDto {
  @ApiPropertyOptional({ description: 'Display name.', example: 'Alice Pérez' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'alice@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;
}

/** Request body of POST /account/password. */
export class ChangePasswordDto {
  @ApiProperty({ description: 'The CURRENT password.' })
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword!: string;
}

/** Request body of POST /account/2fa/enable and /account/2fa/disable. */
export class TwoFaCodeDto {
  @ApiProperty({ description: '6-digit TOTP code.', example: '123456' })
  @IsString()
  @Matches(/^\s*\d{6}\s*$/, { message: 'code must be a 6-digit number' })
  code!: string;
}

/**
 * Request body of PUT /account/smtp (owner item 29 — per-user SMTP override).
 * Mail the user themselves initiates (their own magic-link sign-in, an invite
 * they send as inviter) uses this when enabled, else the app SMTP, else the
 * global default. `pass` is stored ENCRYPTED (auth/secret-cipher.util), never
 * plaintext; omit it to keep the stored one.
 */
export class SetAccountSmtpDto {
  @ApiPropertyOptional({ description: 'Master switch.', example: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'smtp.example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({
    example: 587,
    description: '587 = STARTTLS; 465 = implicit TLS.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ example: 'me@example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  user?: string;

  @ApiPropertyOptional({
    description: 'SMTP password — stored ENCRYPTED, never plaintext.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pass?: string;

  @ApiPropertyOptional({ example: 'Alice <me@example.com>' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  from?: string;
}
