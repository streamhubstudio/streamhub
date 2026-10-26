import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsString, Matches } from 'class-validator';

/**
 * Body for POST /system/backups/restore. Destructive — `confirm` MUST be the
 * literal boolean `true` or the request is rejected (guard against accidental
 * calls, same contract as the DB purge). The service re-validates both names
 * against the snapshot inventory, so no path can be traversed from here.
 */
export class RestoreBackupDto {
  @ApiProperty({
    description:
      "Target database id: 'streamhub' (global registry) or 'app-<name>'.",
    example: 'app-live',
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]*$/i, {
    message: 'db must be a database id (streamhub | app-<name>)',
  })
  db!: string;

  @ApiProperty({
    description:
      'Snapshot filename as listed by GET /system/backups, e.g. ' +
      "'2026-07-06T03-30-00-000Z.db.gz'.",
    example: '2026-07-06T03-30-00-000Z.db.gz',
  })
  @IsString()
  snapshot!: string;

  @ApiProperty({
    description:
      'Must be literally true to authorize overwriting the live database.',
    example: true,
  })
  @IsBoolean()
  @Equals(true, { message: 'confirm must be true to authorize a restore' })
  confirm!: boolean;
}
