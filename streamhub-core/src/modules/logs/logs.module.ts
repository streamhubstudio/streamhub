import { Global, Module } from '@nestjs/common';
import { LOGS_SERVICE } from '../../shared/contracts';
import { AppLogService } from './app-log.service';
import { AppLogsController } from './app-logs.controller';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';

/**
 * Logs module — Global so any module can inject LogsService/LOGS_SERVICE.
 *
 * Also exports AppLogService, the ADDITIVE per-app rotated-log sink
 * (`<dataDir>/apps/<app>/logs/app.log`, Vision-Edge §F) — separate from the
 * global sinks LogsService owns.
 */
@Global()
@Module({
  controllers: [LogsController, AppLogsController],
  providers: [
    LogsService,
    { provide: LOGS_SERVICE, useExisting: LogsService },
    AppLogService,
  ],
  exports: [LogsService, LOGS_SERVICE, AppLogService],
})
export class LogsModule {}
