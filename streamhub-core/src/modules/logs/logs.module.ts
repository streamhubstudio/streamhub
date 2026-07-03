import { Global, Module } from '@nestjs/common';
import { LOGS_SERVICE } from '../../shared/contracts';
import { AppLogsController } from './app-logs.controller';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';

/** Logs module — Global so any module can inject LogsService/LOGS_SERVICE. */
@Global()
@Module({
  controllers: [LogsController, AppLogsController],
  providers: [LogsService, { provide: LOGS_SERVICE, useExisting: LogsService }],
  exports: [LogsService, LOGS_SERVICE],
})
export class LogsModule {}
