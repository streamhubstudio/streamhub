import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Request body of POST /auth/signup. Creates a user + team + owner membership. */
export class SignupDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiProperty({ example: 's3cret-passphrase', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  @ApiPropertyOptional({
    description: 'Optional team/tenant display name. Defaults to the email.',
    example: 'Acme Streaming',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  teamName?: string;
}
