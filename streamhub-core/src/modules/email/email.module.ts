import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * Transactional email (SMTP / nodemailer). Global so any module can inject
 * EmailService (magic-link auth today; invites/notifications later) without
 * re-importing. Reads its SMTP config from env via ConfigService.
 */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
