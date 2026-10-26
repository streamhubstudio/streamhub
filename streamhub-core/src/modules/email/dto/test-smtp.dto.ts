import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

/** Body for `POST /apps/:app/smtp/test` and `POST /account/smtp/test`. */
export class TestSmtpDto {
  @ApiProperty({
    example: 'ops@example.com',
    description: 'Address the probe email is sent to.',
  })
  @IsEmail()
  @MaxLength(200)
  to!: string;
}
