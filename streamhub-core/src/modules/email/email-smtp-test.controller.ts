import { Body, Controller, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { APPS_SERVICE, AppsServiceContract } from '../../shared/contracts';
import { RequirePermission } from '../authz/permission.decorator';
import { EmailService, SendResult } from './email.service';
import { TestSmtpDto } from './dto/test-smtp.dto';

interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Owner item 29 — `POST /apps/:app/smtp/test` sends a probe email using the
 * APP's OWN configured SMTP (bypassing its `enabled` gate, so an operator can
 * verify the settings before flipping the switch live). Lives in EmailModule
 * (not modules/apps) to avoid a module cycle — see EmailModule's doc comment.
 * The per-user equivalent is `POST /account/smtp/test` (AccountController).
 */
@ApiTags('apps')
@ApiBearerAuth()
@Controller('apps/:app/smtp')
export class EmailSmtpTestController {
  constructor(
    private readonly email: EmailService,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
  ) {}

  @Post('test')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: "Send a probe email using this app's configured SMTP.",
    description:
      'Bypasses the smtp.enabled gate so the settings can be verified BEFORE ' +
      'flipping the switch live. Never throws on an SMTP failure — the result ' +
      'body carries ok/error/skipped so the UI can show why it failed.',
  })
  @ApiParam({ name: 'app', example: 'live' })
  @ApiOkResponse({ description: '{ data: SendResult }.' })
  @ApiNotFoundResponse({ description: 'App not found.' })
  async test(
    @Param('app') app: string,
    @Body() dto: TestSmtpDto,
  ): Promise<Envelope<SendResult>> {
    const rec = await this.apps.get(app);
    if (!rec) throw new NotFoundException(`app "${app}" not found`);
    return ok(await this.email.testAppSmtp(app, dto.to));
  }
}
