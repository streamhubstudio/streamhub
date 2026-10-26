import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import { SendResult } from '../email/email.service';
import { TestSmtpDto } from '../email/dto/test-smtp.dto';
import {
  AccountService,
  AccountInfo,
  MaskedAccountSmtp,
  TwoFaSetupResult,
} from './account.service';
import {
  ChangePasswordDto,
  SetAccountSmtpDto,
  TwoFaCodeDto,
  UpdateAccountDto,
} from './dto/account.dto';

interface Envelope<T> {
  data: T;
  error: null;
}

/**
 * "Mi cuenta" (self-service). Every route acts on the CALLER's own user — the
 * principal comes from the resolved AuthContext, never from a param, so a user
 * can only ever read/edit themselves. Human sessions only (user_jwt/admin_jwt);
 * `sk_` API tokens get 403 — a machine has no profile, password or 2FA.
 */
@ApiTags('account')
@ApiBearerAuth()
@Controller('account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  @ApiOperation({ summary: 'My account: profile + tenant + security flags.' })
  @ApiOkResponse({
    description: '{ data: { user, tenant } } for the signed-in user.',
  })
  me(@CurrentAuth() ctx?: AuthContext): Envelope<AccountInfo> {
    return { data: this.account.getAccount(this.requireHuman(ctx)), error: null };
  }

  @Patch()
  @ApiOperation({ summary: 'Update my profile (name and/or email).' })
  @ApiOkResponse({ description: '{ data: { user, tenant } } after the update.' })
  update(
    @Body() dto: UpdateAccountDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<AccountInfo> {
    return {
      data: this.account.updateAccount(this.requireHuman(ctx), {
        name: dto.name,
        email: dto.email,
      }),
      error: null,
    };
  }

  @Post('password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change my password (requires the current password).',
  })
  @ApiOkResponse({ description: '{ data: { ok: true } }.' })
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ ok: true }> {
    this.account.changePassword(
      this.requireHuman(ctx),
      dto.currentPassword,
      dto.newPassword,
    );
    return { data: { ok: true }, error: null };
  }

  // ---------------------------------------------------------------------------
  // 2FA (TOTP)
  // ---------------------------------------------------------------------------

  @Post('2fa/setup')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start 2FA enrolment: returns secret + otpauth URI + QR data URI.',
    description:
      'Stores the new secret ENCRYPTED as pending. 2FA only activates after ' +
      'POST /account/2fa/enable verifies a live code from the authenticator.',
  })
  @ApiOkResponse({ description: '{ data: { secret, otpauthUri, qrDataUri } }.' })
  async setup2fa(
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<TwoFaSetupResult>> {
    return {
      data: await this.account.setupTwoFa(this.requireHuman(ctx)),
      error: null,
    };
  }

  @Post('2fa/enable')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Activate 2FA by verifying a code against the pending secret.',
  })
  @ApiOkResponse({ description: '{ data: { enabled: true } }.' })
  enable2fa(
    @Body() dto: TwoFaCodeDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ enabled: boolean }> {
    this.account.enableTwoFa(this.requireHuman(ctx), dto.code);
    return { data: { enabled: true }, error: null };
  }

  @Post('2fa/disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disable 2FA (requires a live valid code).' })
  @ApiOkResponse({ description: '{ data: { enabled: false } }.' })
  disable2fa(
    @Body() dto: TwoFaCodeDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<{ enabled: boolean }> {
    this.account.disableTwoFa(this.requireHuman(ctx), dto.code);
    return { data: { enabled: false }, error: null };
  }

  // ---------------------------------------------------------------------------
  // Per-user SMTP override (owner item 29)
  // ---------------------------------------------------------------------------

  @Get('smtp')
  @ApiOperation({
    summary: 'My SMTP override (password masked).',
    description:
      'Mail I initiate (my own magic-link sign-in, an invite I send as ' +
      'inviter) uses this when enabled, else the app SMTP, else the global ' +
      'default. Test with POST /account/smtp/test.',
  })
  @ApiOkResponse({ description: '{ data: MaskedAccountSmtp }.' })
  getSmtp(@CurrentAuth() ctx?: AuthContext): Envelope<MaskedAccountSmtp> {
    return { data: this.account.getSmtp(this.requireHuman(ctx)), error: null };
  }

  @Put('smtp')
  @ApiOperation({
    summary: 'Update my SMTP override. Omit pass to keep the stored one.',
    description:
      'The password is stored ENCRYPTED (auth/secret-cipher.util), never plaintext.',
  })
  @ApiOkResponse({ description: '{ data: MaskedAccountSmtp } after the update.' })
  setSmtp(
    @Body() dto: SetAccountSmtpDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Envelope<MaskedAccountSmtp> {
    return {
      data: this.account.setSmtp(this.requireHuman(ctx), dto),
      error: null,
    };
  }

  @Post('smtp/test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a probe email using MY configured SMTP.',
    description:
      'Bypasses the enabled gate so the settings can be verified BEFORE ' +
      'flipping the switch live. Never throws on an SMTP failure — the result ' +
      'body carries ok/error/skipped.',
  })
  @ApiOkResponse({ description: '{ data: SendResult }.' })
  async testSmtp(
    @Body() dto: TestSmtpDto,
    @CurrentAuth() ctx?: AuthContext,
  ): Promise<Envelope<SendResult>> {
    const result = await this.account.testSmtp(this.requireHuman(ctx), dto.to);
    return { data: result, error: null };
  }

  /** Account routes are for signed-in HUMANS; machine tokens are rejected. */
  private requireHuman(ctx?: AuthContext): AuthContext {
    if (!ctx || ctx.via === 'api_token') {
      throw new ForbiddenException('API tokens have no account');
    }
    return ctx;
  }
}
