import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigService } from '../../shared/config/config.service';

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
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * Transactional email over SMTP (nodemailer). Owns the single reusable
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

  constructor(private readonly config: ConfigService) {
    this.settings = this.resolveSettings();
  }

  /** True when a usable SMTP host+pass are configured. */
  get isConfigured(): boolean {
    return !!this.settings.host && !!this.settings.pass;
  }

  /** The From header this service stamps on outgoing mail. */
  get fromAddress(): string {
    return this.settings.from;
  }

  /**
   * Send the passwordless magic-link email. Plain-text + HTML body with a short
   * validity notice. Never throws — returns a {@link SendResult}.
   */
  async sendMagicLink(email: string, url: string): Promise<SendResult> {
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

    return this.send({ to: email, subject, text, html });
  }

  /**
   * Send the password-reset email. Plain-text + HTML body with a short validity
   * notice (30-min single-use link). Never throws — returns a {@link SendResult}.
   */
  async sendPasswordReset(email: string, url: string): Promise<SendResult> {
    const subject = 'Reset your StreamHub password';
    const text =
      `Reset your StreamHub password\n\n` +
      `We received a request to reset your password. Click the link below to ` +
      `choose a new one. It works once and expires in 30 minutes:\n\n` +
      `${url}\n\n` +
      `If you did not request this, you can safely ignore this email — your ` +
      `password will not change.`;
    const html =
      `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto">` +
      `<h2 style="margin:0 0 16px">Reset your StreamHub password</h2>` +
      `<p style="color:#334155;line-height:1.5">We received a request to reset ` +
      `your password. Click the button below to choose a new one. ` +
      `This link works once and expires in 30 minutes.</p>` +
      `<p style="margin:24px 0"><a href="${this.escapeHtml(url)}" ` +
      `style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;` +
      `text-decoration:none;display:inline-block">Reset password</a></p>` +
      `<p style="color:#64748b;font-size:13px;line-height:1.5">Or paste this URL into your browser:<br>` +
      `<a href="${this.escapeHtml(url)}">${this.escapeHtml(url)}</a></p>` +
      `<p style="color:#94a3b8;font-size:12px;margin-top:24px">` +
      `If you did not request this, you can safely ignore this email — your ` +
      `password will not change.</p></div>`;

    return this.send({ to: email, subject, text, html });
  }

  /**
   * Send a team-invitation email carrying a sign-in (magic) link. Never throws
   * — returns a {@link SendResult}.
   */
  async sendInvite(
    email: string,
    url: string,
    opts: { teamName?: string; role?: string; invitedBy?: string } = {},
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

    return this.send({ to: email, subject, text, html });
  }

  /**
   * Low-level send. Builds (and caches) the transport lazily so tests that never
   * send don't open a connection, and a config with no PASS short-circuits to a
   * skipped result instead of dialing SMTP. Never throws.
   */
  async send(msg: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<SendResult> {
    if (!this.isConfigured) {
      this.logger.warn(
        `email not sent to <${this.mask(msg.to)}>: SMTP not configured ` +
          `(set STREAMHUB_SMTP_HOST + STREAMHUB_SMTP_PASS)`,
      );
      return { ok: false, skipped: true, error: 'smtp_not_configured' };
    }
    try {
      const transporter = this.getTransporter();
      const info = await transporter.sendMail({
        from: this.settings.from,
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
  // Internals
  // ---------------------------------------------------------------------------

  /** Lazily build + cache the nodemailer transport. */
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.settings.host,
        port: this.settings.port,
        // 465 = implicit TLS; 587/others = STARTTLS upgrade (secure:false).
        secure: this.settings.secure,
        auth: { user: this.settings.user, pass: this.settings.pass },
        requireTLS: !this.settings.secure,
      });
    }
    return this.transporter;
  }

  private resolveSettings(): SmtpSettings {
    const port = this.intEnv('STREAMHUB_SMTP_PORT', 587);
    return {
      host: this.strEnv('STREAMHUB_SMTP_HOST', 'mail.wipermax.online'),
      port,
      secure: port === 465,
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
