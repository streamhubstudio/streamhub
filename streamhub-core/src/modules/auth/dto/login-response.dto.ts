import { ApiProperty } from '@nestjs/swagger';

/** Inner payload of the login response. */
export class LoginTokenDto {
  @ApiProperty({
    description: 'HS256 JWT (sub=user, ~12h expiry). Send as Bearer token.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiJ9.sig',
  })
  token!: string;
}

/** Response body of POST /auth/login — `{ data: { token } }`. */
export class LoginResponseDto {
  @ApiProperty({ type: LoginTokenDto })
  data!: LoginTokenDto;
}
