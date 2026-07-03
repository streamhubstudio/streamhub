import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request body of POST /auth/reset — the one-time token from the emailed link
 * plus the new password to set (scrypt-hashed by the service).
 */
export class ResetDto {
  @ApiProperty({
    description: 'The one-time token from the emailed reset link.',
    example: 'kJ3v...base64url',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  token!: string;

  @ApiProperty({ example: 's3cret-passphrase', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}
