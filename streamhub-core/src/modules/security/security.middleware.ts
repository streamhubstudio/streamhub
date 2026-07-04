import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ConfigService } from '../../shared/config/config.service';
import { clientIpOf, isPrivateOrLoopbackIp } from './ip-cidr.util';
import { IpReputationService } from './ip-reputation.service';
import { IpRulesService } from './ip-rules.service';
import {
  resolveSecuritySettings,
  type SecuritySettings,
} from './security-settings';

/** Request annotated in log mode (visible to downstream logging/handlers). */
export interface RequestWithIpAccess extends Request {
  ipAccess?: 'would_block';
}

/** Generic bodies — deliberately reveal NOTHING about which rule/ban matched. */
const BLOCKED_BODY = {
  data: null,
  error: { code: 'forbidden', message: 'Access denied' },
};
const BANNED_BODY = {
  data: null,
  error: { code: 'rate_limited', message: 'Too many requests. Please retry later.' },
};

/**
 * Network-security enforcement (single early hook). Applied by SecurityModule
 * to EVERY route via MiddlewareConsumer, so it runs BEFORE all guards/handlers
 * but after Express resolved the proxy-forwarded client IP.
 *
 * Order per request (all in-memory, no DB):
 *  1. loopback / RFC1918 / link-local → always pass (lock-out guarantee; the
 *     Docker healthcheck and /metrics scrapes from localhost can never break);
 *  2. explicit allow rule → pass (also shields the IP from ban checks);
 *  3. active auto-ban (when STREAMHUB_AUTOBAN_ENABLED) → 429;
 *  4. explicit block rule, or allowlist-only default-deny → 403 in `enforce`
 *     mode; in `log` mode it only logs + annotates; `off` skips rules entirely.
 *
 * Responses are small generic JSON envelopes and the log line is structured —
 * the client never learns WHICH rule matched.
 */
@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SecurityMiddleware.name);
  private readonly settings: SecuritySettings;

  constructor(
    config: ConfigService,
    private readonly rules: IpRulesService,
    private readonly reputation: IpReputationService,
  ) {
    this.settings = resolveSecuritySettings(config);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const s = this.settings;
    // Fully dormant: zero per-request work when every knob is off.
    if (s.mode === 'off' && !s.autobanEnabled) {
      next();
      return;
    }

    const ip = clientIpOf(req);
    if (!ip) {
      next();
      return;
    }

    // 1) The lock-out guarantee — local/private traffic is never touched.
    if (isPrivateOrLoopbackIp(ip)) {
      next();
      return;
    }

    // Optional 404-storm offenses (public IPs only; recorded on response end).
    if (s.autobanEnabled && s.autoban404Enabled) {
      res.on('finish', () => {
        if (res.statusCode === 404) {
          this.reputation.recordOffense(ip, 'not_found');
        }
      });
    }

    // 2) Explicit allow wins over everything else (incl. an existing ban).
    const match = this.rules.evaluate(ip);
    if (match === 'allow') {
      next();
      return;
    }

    // 3) Active auto-ban → 429 (generic).
    if (s.autobanEnabled && this.reputation.isBanned(ip)) {
      this.deny(req, res, ip, 'banned', 429, BANNED_BODY);
      return;
    }

    // 4) Blocklist / allowlist-only default-deny, per mode.
    if (s.mode === 'off') {
      next();
      return;
    }
    const blocked = match === 'block' || s.allowlistOnly;
    if (!blocked) {
      next();
      return;
    }
    const why = match === 'block' ? 'blocklist' : 'allowlist_only';
    if (s.mode === 'enforce') {
      this.deny(req, res, ip, why, 403, BLOCKED_BODY);
      return;
    }
    // log mode: record + annotate, never reject.
    (req as RequestWithIpAccess).ipAccess = 'would_block';
    this.logger.warn(
      `ip-access would_block ip=${ip} why=${why} mode=log method=${req.method} path=${req.path}`,
    );
    next();
  }

  private deny(
    req: Request,
    res: Response,
    ip: string,
    why: string,
    status: number,
    body: unknown,
  ): void {
    this.logger.warn(
      `ip-access deny ip=${ip} why=${why} status=${status} method=${req.method} path=${req.path}`,
    );
    res.status(status).json(body);
  }
}
