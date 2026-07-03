import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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
