import { Global, Module } from '@nestjs/common';

import { QuotasController } from './quotas.controller';
import { QuotasService } from './quotas.service';

/**
 * Quotas module (wave-5). Global so controllers can inject QuotasService for
 * pre-flight checks (create-app, start-stream/ingress, recording/egress) without
 * per-module wiring. Exposes GET /tenants/:id/usage.
 */
@Global()
@Module({
  controllers: [QuotasController],
  providers: [QuotasService],
  exports: [QuotasService],
})
export class QuotasModule {}
