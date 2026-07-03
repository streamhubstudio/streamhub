import { Module } from '@nestjs/common';
import { S3_SERVICE } from '../../shared/contracts';
import { S3Service } from './s3.service';
import { SecretsStore } from './secrets.store';

/**
 * S3 storage module. Exports S3_SERVICE (contract token) for cross-module
 * consumers, plus the concrete S3Service and the SecretsStore (so the apps
 * module can resolve credentials from data/secrets.json instead of the yaml).
 */
@Module({
  providers: [
    S3Service,
    SecretsStore,
    { provide: S3_SERVICE, useExisting: S3Service },
  ],
  exports: [S3Service, S3_SERVICE, SecretsStore],
})
export class S3Module {}
