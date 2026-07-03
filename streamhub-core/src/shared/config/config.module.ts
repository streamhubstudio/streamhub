import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';

/** Global config module — ConfigService injectable everywhere. */
@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
