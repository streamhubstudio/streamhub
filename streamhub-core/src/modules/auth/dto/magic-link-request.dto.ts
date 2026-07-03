import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

/** Request body of POST /auth/magic-link — the email to send a sign-in link to. */
export class MagicLinkRequestDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  @MaxLength(200)
  email!: string;
}
