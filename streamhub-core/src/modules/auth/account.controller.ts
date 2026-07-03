import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';
import {
  AccountService,
  AccountInfo,
  TwoFaSetupResult,
} from './account.service';
import {
  ChangePasswordDto,
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

  /** Account routes are for signed-in HUMANS; machine tokens are rejected. */
  private requireHuman(ctx?: AuthContext): AuthContext {
    if (!ctx || ctx.via === 'api_token') {
      throw new ForbiddenException('API tokens have no account');
    }
    return ctx;
  }
}
