import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

/** Request body of POST /auth/reset-request — the email to send a reset link to. */
export class ResetRequestDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  @MaxLength(200)
  email!: string;
}
