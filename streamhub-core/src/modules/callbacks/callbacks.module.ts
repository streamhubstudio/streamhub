import { Global, Module } from '@nestjs/common';
import { CALLBACKS_SERVICE } from '../../shared/contracts';
import { AppsModule } from '../apps/apps.module';
import { CallbacksService } from './callbacks.service';

/**
 * Callbacks module — Global so any module can dispatch outbound webhooks.
 * Outbound only: no controller. Imports AppsModule to read callbacks.{url,secret}
 * via APPS_SERVICE (LOGS_SERVICE is global). Exports CALLBACKS_SERVICE.
 */
@Global()
@Module({
  imports: [AppsModule],
  providers: [
    CallbacksService,
    { provide: CALLBACKS_SERVICE, useExisting: CallbacksService },
  ],
  exports: [CallbacksService, CALLBACKS_SERVICE],
})
export class CallbacksModule {}
