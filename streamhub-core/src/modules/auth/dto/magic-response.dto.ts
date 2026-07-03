import { ApiProperty } from '@nestjs/swagger';

/** Inner payload of the generic magic-link request response. */
export class MagicLinkRequestResultDto {
  @ApiProperty({
    description:
      'Generic acknowledgement. Intentionally reveals nothing about whether ' +
      'the email exists or a link was actually sent (anti-enumeration).',
    example: 'If that email is valid, we just sent a sign-in link.',
  })
  message!: string;
}

/** Response body of POST /auth/magic-link — always a generic 200. */
export class MagicLinkResponseDto {
  @ApiProperty({ type: MagicLinkRequestResultDto })
  data!: MagicLinkRequestResultDto;
}
