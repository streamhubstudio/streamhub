import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '../../shared/config/config.service';
import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { TenancyService } from '../tenancy/tenancy.service';
import { decryptUserSmtpSecret } from '../auth/secret-cipher.util';

/** Result of a send attempt — never throws, so callers can stay generic. */
export interface SendResult {
  ok: boolean;
  /** nodemailer messageId on success. */
  messageId?: string;
  /** Error message on failure (already logged). */
  error?: string;
  /** True when SMTP is not configured and the send was skipped. */
  skipped?: boolean;
}

/**
 * Resolved SMTP settings (read once from env via ConfigService). PASS is read
 * from the environment and NEVER logged or echoed back.
 */
interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/**
 * Owner item 29 — where to resolve an override SMTP for a given send, in
 * PRECEDENCE ORDER: per-user (mail the user themselves initiates: their own
 * magic-link sign-in, an invite THEY send as inviter) beats per-app (app-scoped
 * notifications: the notifier email channel) beats the global env default.
 * Both fields are optional and independent — a caller passes whichever
 * context it has; omitting both always resolves to the global default.
 */
export interface SendContext {
  /** Prefer this user's personal SMTP override, if enabled + fully configured. */
  userId?: string;
  /** Else prefer this app's SMTP override, if enabled + fully configured. */
  app?: string;
}

/** Minimal shape `buildTransporter` needs — one per override, or the global default. */
interface ResolvedSmtp {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/**
 * Transactional email over SMTP (nodemailer). Owns the single reusable GLOBAL
 * transport built from env:
 *
 *   STREAMHUB_SMTP_HOST   (default mail.wipermax.online)
 *   STREAMHUB_SMTP_PORT   (default 587 → STARTTLS)
 *   STREAMHUB_SMTP_USER   (default no-reply@streamhub.studio)
 *   STREAMHUB_SMTP_PASS   (REQUIRED, secret — never hardcoded/committed)
 *   STREAMHUB_SMTP_FROM   (default "StreamHub <no-reply@streamhub.studio>")
 *
 * Port 587 uses `secure:false` + STARTTLS (nodemailer upgrades automatically);
 * port 465 uses implicit TLS (`secure:true`).
 *
 * OWNER ITEM 29 (per-app + per-user SMTP): every send method takes an optional
 * {@link SendContext}. `resolveTransport` picks the SMTP to actually use —
 * per-user override > per-app override > this global default — building a
 * FRESH transporter for an override (settings can change at runtime via the
 * UI) while the global transporter stays cached across sends (unchanged
 * behaviour). `APPS_SERVICE`/`TenancyService` are `@Optional()` so existing
 * bare `new EmailService(new ConfigService())` constructions (tests) keep
 * compiling — without them, every send just resolves to the global default,
 * exactly like before this feature existed.
 *
 * ROBUSTNESS CONTRACT: no method here throws on SMTP failure. Every send is
 * wrapped so a dead/misconfigured mail server can never crash the request that
 * triggered it (e.g. magic-link issuance still returns its generic 200). All
 * failures are logged and reported via the returned {@link SendResult}.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly settings: SmtpSettings;
  private transporter?: Transporter;

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(APPS_SERVICE)
    private readonly apps?: AppsServiceContract,
    @Optional() private readonly tenancy?: TenancyService,
  ) {
    this.settings = this.resolveSettings();
  }

  /** True when a usable GLOBAL SMTP host+pass are configured. */
  get isConfigured(): boolean {
    return !!this.settings.host && !!this.settings.pass;
  }

  /** The From header the GLOBAL default stamps on outgoing mail. */
  get fromAddress(): string {
    return this.settings.from;
  }

  /**
   * Send the passwordless magic-link email. Plain-text + HTML body with a short
   * validity notice. Never throws — returns a {@link SendResult}.
   *
   * `ctx.userId` (owner item 29): when the target user has their OWN SMTP
   * override enabled, the link is delivered through IT instead of the app/
   * global default — this is "mail the user initiates" (they clicked "email
   * me a link"), the closest fit among today's mail categories.
   */
  async sendMagicLink(
    email: string,
    url: string,
    ctx?: SendContext,
  ): Promise<SendResult> {
    const subject = 'Your StreamHub sign-in link';
    const text =
      `Sign in to StreamHub\n\n` +
      `Click the link below to sign in. It works once and expires in 15 minutes:\n\n` +
      `${url}\n\n` +
      `If you did not request this, you can safely ignore this email.`;
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto">` +
      `<h2 style="margin:0 0 16px">Sign in to StreamHub</h2>` +
      `<p style="color:#334155;line-height:1.5">Click the button below to sign in. ` +
      `This link works once and expires in 15 minutes.</p>` +
      `<p style="margin:24px 0"><a href="${this.escapeHtml(url)}" ` +
      `style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;` +
      `text-decoration:none;display:inline-block">Sign in</a></p>` +
      `<p style="color:#64748b;font-size:13px;line-height:1.5">Or paste this URL into your browser:<br>` +
      `<a href="${this.escapeHtml(url)}">${this.escapeHtml(url)}</a></p>` +
      `<p style="color:#94a3b8;font-size:12px;margin-top:24px">` +
      `If you did not request this, you can safely ignore this email.</p></div>`;

    return this.send({ to: email, subject, text, html }, ctx);
  }

  /**
   * Send a team-invitation email carrying a sign-in (magic) link. Never throws
   * — returns a {@link SendResult}.
   *
   * `ctx.userId` (owner item 29): the INVITER's own SMTP override, when set —
   * inviting a teammate is an action that user initiates, so their personal
   * SMTP (if configured) delivers it instead of the global default.
   */
  async sendInvite(
    email: string,
    url: string,
    opts: { teamName?: string; role?: string; invitedBy?: string } = {},
    ctx?: SendContext,
  ): Promise<SendResult> {
    const team = opts.teamName || 'a StreamHub team';
    const by = opts.invitedBy ? ` by ${opts.invitedBy}` : '';
    const roleLine = opts.role ? ` as ${opts.role}` : '';
    const subject = `You've been invited to ${team} on StreamHub`;
    const text =
      `Join ${team} on StreamHub\n\n` +
      `You have been invited${by} to join ${team}${roleLine}. ` +
      `Click the link below to accept the invitation and sign in. ` +
      `It works once and expires in 72 hours:\n\n` +
      `${url}\n\n` +
      `If you did not expect this invitation, you can safely ignore this email.`;
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto">` +
      `<h2 style="margin:0 0 16px">Join ${this.escapeHtml(team)} on StreamHub</h2>` +
      `<p style="color:#334155;line-height:1.5">You have been invited${this.escapeHtml(by)} ` +
      `to join <strong>${this.escapeHtml(team)}</strong>${this.escapeHtml(roleLine)}. ` +
      `Click the button below to accept the invitation and sign in. ` +
      `This link works once and expires in 72 hours.</p>` +
      `<p style="margin:24px 0"><a href="${this.escapeHtml(url)}" ` +
      `style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;` +
      `text-decoration:none;display:inline-block">Accept invitation</a></p>` +
      `<p style="color:#64748b;font-size:13px;line-height:1.5">Or paste this URL into your browser:<br>` +
      `<a href="${this.escapeHtml(url)}">${this.escapeHtml(url)}</a></p>` +
      `<p style="color:#94a3b8;font-size:12px;margin-top:24px">` +
      `If you did not expect this invitation, you can safely ignore this email.</p></div>`;

    return this.send({ to: email, subject, text, html }, ctx);
  }

  /**
   * Low-level send. Resolves the transport per {@link SendContext} (user > app
   * > global). A config with no usable SMTP anywhere short-circuits to a
   * skipped result instead of dialing SMTP. Never throws.
   */
  async send(
    msg: { to: string; subject: string; text: string; html?: string },
    ctx?: SendContext,
  ): Promise<SendResult> {
    const resolved = await this.resolveTransport(ctx);
    if (!resolved) {
      this.logger.warn(
        `email not sent to <${this.mask(msg.to)}>: SMTP not configured ` +
          `(set STREAMHUB_SMTP_HOST + STREAMHUB_SMTP_PASS, or a per-app/per-user override)`,
      );
      return { ok: false, skipped: true, error: 'smtp_not_configured' };
    }
    try {
      const info = await resolved.transporter.sendMail({
        from: resolved.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      this.logger.log(
        `email sent to <${this.mask(msg.to)}> (id=${info.messageId})`,
      );
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(
        `email send to <${this.mask(msg.to)}> failed: ${error}`,
      );
      return { ok: false, error };
    }
  }

  // ---------------------------------------------------------------------------
  // Owner item 29 — probe/"test send" (bypasses the `enabled` gate so an
  // operator can verify settings BEFORE flipping the switch live).
  // ---------------------------------------------------------------------------

  /** Send a probe email using the APP's OWN configured SMTP. Never falls back. */
  async testAppSmtp(app: string, to: string): Promise<SendResult> {
    if (!this.apps) return { ok: false, error: 'apps_service_unavailable' };
    let smtp: ResolvedSmtp | undefined;
    try {
      const cfg = await this.apps.getConfig(app);
      if (cfg.smtp?.host && cfg.smtp.pass) {
        smtp = {
          host: cfg.smtp.host,
          port: cfg.smtp.port || 587,
          user: cfg.smtp.user,
          pass: cfg.smtp.pass,
          from: cfg.smtp.from || this.settings.from,
        };
      }
    } catch {
      return { ok: false, error: 'app_not_found' };
    }
    if (!smtp) {
      return { ok: false, skipped: true, error: 'smtp_not_configured' };
    }
    return this.sendProbe(smtp, to);
  }

  /** Send a probe email using the USER's OWN configured SMTP. Never falls back. */
  async testUserSmtp(userId: string, to: string): Promise<SendResult> {
    if (!this.tenancy) return { ok: false, error: 'tenancy_unavailable' };
    const row = this.tenancy.getUserSmtp(userId);
    if (!row?.host || !row.passEnc) {
      return { ok: false, skipped: true, error: 'smtp_not_configured' };
    }
    const pass = decryptUserSmtpSecret(row.passEnc, this.config.jwtSecret || '');
    if (!pass) return { ok: false, error: 'decrypt_failed' };
    return this.sendProbe(
      {
        host: row.host,
        port: row.port && row.port > 0 ? row.port : 587,
        user: row.user,
        pass,
        from: row.from || this.settings.from,
      },
      to,
    );
  }

  private async sendProbe(smtp: ResolvedSmtp, to: string): Promise<SendResult> {
    const transporter = this.buildTransporter(smtp);
    const subject = 'StreamHub SMTP test';
    const text =
      'This is a test email from StreamHub confirming this SMTP configuration works.';
    try {
      const info = await transporter.sendMail({
        from: smtp.from,
        to,
        subject,
        text,
        html: `<p>${this.escapeHtml(text)}</p>`,
      });
      this.logger.log(`test email sent to <${this.mask(to)}> (id=${info.messageId})`);
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(`test email to <${this.mask(to)}> failed: ${error}`);
      return { ok: false, error };
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Resolve which SMTP to use for this send — per-user override > per-app
   * override > the global default. Best-effort at every step: a lookup
   * failure (unknown app/user, decrypt failure) simply falls through to the
   * next tier instead of failing the send.
   */
  private async resolveTransport(
    ctx?: SendContext,
  ): Promise<{ transporter: Transporter; from: string } | null> {
    if (ctx?.userId && this.tenancy) {
      try {
        const row = this.tenancy.getUserSmtp(ctx.userId);
        if (row?.enabled && row.host && row.passEnc) {
          const pass = decryptUserSmtpSecret(
            row.passEnc,
            this.config.jwtSecret || '',
          );
          if (pass) {
            const smtp: ResolvedSmtp = {
              host: row.host,
              port: row.port && row.port > 0 ? row.port : 587,
              user: row.user,
              pass,
              from: row.from || this.settings.from,
            };
            return { transporter: this.buildTransporter(smtp), from: smtp.from };
          }
        }
      } catch {
        /* fall through to app/global */
      }
    }

    if (ctx?.app && this.apps) {
      try {
        const cfg = await this.apps.getConfig(ctx.app);
        if (cfg.smtp?.enabled && cfg.smtp.host && cfg.smtp.pass) {
          const smtp: ResolvedSmtp = {
            host: cfg.smtp.host,
            port: cfg.smtp.port || 587,
            user: cfg.smtp.user,
            pass: cfg.smtp.pass,
            from: cfg.smtp.from || this.settings.from,
          };
          return { transporter: this.buildTransporter(smtp), from: smtp.from };
        }
      } catch {
        /* fall through to global */
      }
    }

    if (!this.isConfigured) return null;
    return { transporter: this.getTransporter(), from: this.settings.from };
  }

  /** Lazily build + cache the GLOBAL nodemailer transport. */
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = this.buildTransporter({
        host: this.settings.host,
        port: this.settings.port,
        user: this.settings.user,
        pass: this.settings.pass,
      });
    }
    return this.transporter;
  }

  /**
   * Build a nodemailer transport for a resolved SMTP (global, per-app or
   * per-user). NOT cached for overrides — settings can change at runtime via
   * the UI and sends are infrequent, so correctness wins over the tiny cost of
   * rebuilding. 465 = implicit TLS; anything else = STARTTLS upgrade.
   */
  private buildTransporter(smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
  }): Transporter {
    const secure = smtp.port === 465;
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure,
      auth: { user: smtp.user, pass: smtp.pass },
      requireTLS: !secure,
    });
  }

  private resolveSettings(): SmtpSettings {
    const port = this.intEnv('STREAMHUB_SMTP_PORT', 587);
    return {
      host: this.strEnv('STREAMHUB_SMTP_HOST', 'mail.wipermax.online'),
      port,
      user: this.strEnv('STREAMHUB_SMTP_USER', 'no-reply@streamhub.studio'),
      // No default — the secret must come from the environment.
      pass: this.strEnv('STREAMHUB_SMTP_PASS', ''),
      from: this.strEnv(
        'STREAMHUB_SMTP_FROM',
        'StreamHub <no-reply@streamhub.studio>',
      ),
    };
  }

  private strEnv(name: string, fallback: string): string {
    const v = this.config.env(name);
    return v === undefined || v === '' ? fallback : v;
  }

  private intEnv(name: string, fallback: number): number {
    const v = this.config.env(name);
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  /** Mask an email for logs: `al***@example.com`. */
  private mask(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at);
    const shown = local.slice(0, Math.min(2, local.length));
    return `${shown}***${domain}`;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
