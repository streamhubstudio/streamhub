import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsIn } from 'class-validator';

/** What slice of an app's data a purge removes. */
export type PurgeScope = 'vods' | 'logs' | 'all';

/**
 * Body for POST /apps/:app/db/purge. Destructive — `confirm` MUST be the
 * literal boolean `true` or the request is rejected (guard against accidental
 * calls). `scope` selects the slice; `all` wipes app-scoped DATA (vods with
 * their S3/local cascade + streams + the app's server_logs) while KEEPING the
 * app registration and its config.
 */
export class PurgeDbDto {
  @ApiProperty({
    enum: ['vods', 'logs', 'all'],
    description:
      "'vods' = VODs (+S3+local cascade); 'logs' = the app's server_logs; " +
      "'all' = all app-scoped data but keep the app + its config.",
  })
  @IsIn(['vods', 'logs', 'all'])
  scope!: PurgeScope;

  @ApiProperty({
    description: 'Must be literally true to authorize the destructive purge.',
    example: true,
  })
  @IsBoolean()
  @Equals(true, { message: 'confirm must be true to authorize a purge' })
  confirm!: boolean;
}
