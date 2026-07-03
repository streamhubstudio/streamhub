import { Global, Module } from '@nestjs/common';
import { TenancyService } from './tenancy.service';

/**
 * Tenancy control-plane (Wave-5 §auth). Global so the auth guard and any future
 * per-route permission checks can inject TenancyService without re-importing.
 */
@Global()
@Module({
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}
