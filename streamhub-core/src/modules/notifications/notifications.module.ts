import { Global, Module } from '@nestjs/common';

import { NOTIFIER_SERVICE } from './notifier.contract';
import { NotifierService } from './notifier.service';

/**
 * Notifications module (Vision-Edge §H) — Global so any module can inject the
 * notifier fan-out. Depends only on @Global providers (ConfigService,
 * AppLogService, EmailService, CALLBACKS_SERVICE), so it needs no imports.
 *
 * Exports both the concrete NotifierService and the NOTIFIER_SERVICE token; the
 * lead aliases the edge module's EDGE_NOTIFIER seam onto NOTIFIER_SERVICE when
 * wiring the edge channel (this module stays decoupled from `modules/edge`).
 */
@Global()
@Module({
  providers: [
    NotifierService,
    { provide: NOTIFIER_SERVICE, useExisting: NotifierService },
  ],
  exports: [NotifierService, NOTIFIER_SERVICE],
})
export class NotificationsModule {}
