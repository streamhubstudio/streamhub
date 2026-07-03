import { ApiProperty } from '@nestjs/swagger';
import { CreatedToken, TokenSummary } from '../auth.service';

/** Response of POST /tokens — plaintext shown ONCE. */
export class CreatedTokenDto implements CreatedToken {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({
    description: 'Plaintext token, returned only once. Store it now.',
    example: 'sk_2Qf...redacted',
  })
  token!: string;
}

/** Item of GET /tokens. The plaintext token is never returned here. */
export class TokenSummaryDto implements TokenSummary {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'ui-server' })
  name!: string;

  @ApiProperty({ enum: ['global', 'app'], example: 'global' })
  scope!: 'global' | 'app';

  @ApiProperty({ nullable: true, example: null })
  appId!: number | null;

  @ApiProperty({ nullable: true, example: null })
  lastUsedAt!: string | null;

  @ApiProperty({ example: '2026-06-30 12:00:00' })
  createdAt!: string;

  @ApiProperty({ example: false })
  revoked!: boolean;
}
