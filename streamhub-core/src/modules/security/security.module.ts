import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { IpRulesService } from './ip-rules.service';
import { IpReputationService } from './ip-reputation.service';
import { SecurityController } from './security.controller';
import { SecurityMiddleware } from './security.middleware';

/**
 * Network security — in-app IP access control + abuse protection (defensive):
 *
 *  - global allow/blocklist with CIDR support (ip_rules, IpRulesService),
 *  - in-app fail2ban with escalating bans (ip_bans, IpReputationService),
 *  - one EARLY middleware enforcing both on every route (SecurityMiddleware),
 *  - a superadmin admin API under /api/v1/security/* (SecurityController).
 *
 * The middleware is registered here via MiddlewareConsumer (forRoutes '*') so
 * it runs ahead of every guard/handler WITHOUT touching main.ts. It is a
 * complement to — not a replacement for — the reverse proxy / OS firewall.
 * Docs: streamhub-docs/features/network-security.md.
 */
@Module({
  controllers: [SecurityController],
  providers: [IpRulesService, IpReputationService, SecurityMiddleware],
  exports: [IpReputationService, IpRulesService],
})
export class SecurityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SecurityMiddleware).forRoutes('*');
  }
}
