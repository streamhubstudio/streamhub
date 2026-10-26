import { Global, Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { EmailService } from './email.service';
import { EmailSmtpTestController } from './email-smtp-test.controller';

/**
 * Transactional email (SMTP / nodemailer). Global so any module can inject
 * EmailService (magic-link auth, invites, the notifier email channel)
 * without re-importing. Reads its GLOBAL SMTP config from env via
 * ConfigService; per-app overrides (owner item 29) are resolved through
 * APPS_SERVICE, hence the AppsModule import (one-way — AppsModule does NOT
 * import EmailModule, so no cycle). Per-user overrides resolve through
 * TenancyService, which is itself `@Global()` (no import needed here).
 *
 * `EmailSmtpTestController` owns `POST /apps/:app/smtp/test` (the app-level
 * SMTP probe) — it lives here rather than in `modules/apps` specifically to
 * avoid that cycle (apps.controller.ts never touches EmailService).
 */
@Global()
@Module({
  imports: [AppsModule],
  controllers: [EmailSmtpTestController],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
