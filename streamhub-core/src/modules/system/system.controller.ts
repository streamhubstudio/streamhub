import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { GpuService } from './gpu.service';
import { GpuStatusDto } from './dto/gpu-status.dto';
import { GpuStatus } from './gpu.types';
import { SettingsService } from './settings.service';
import { ServerSettings } from './settings.types';
import { AuthContext, CurrentAuth } from '../../shared/auth-context';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}

function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * System capabilities (SPEC §5 transcoding, GPU-optional). Exposes the node's
 * GPU hardware-transcoding status so the panel can show whether acceleration is
 * available and apps can choose `hwaccel`. Auth-guarded (Bearer) like /stats.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class SystemController {
  constructor(
    private readonly gpu: GpuService,
    private readonly settings: SettingsService,
  ) {}

  @Get('gpu')
  @ApiOperation({
    summary: 'GPU hardware-transcoding status of this node.',
    description:
      'Detects NVIDIA (nvidia-smi) and VAAPI (/dev/dri). Returns ' +
      '{ available, type, devices, driver? }. Never errors: a node with no ' +
      'GPU/driver/permission reports available:false, type:"none". Pass ' +
      '?refresh=true to force a re-probe.',
  })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  @ApiOkResponse({ type: GpuStatusDto })
  async getGpu(@Query('refresh') refresh?: string): Promise<GpuStatus> {
    const force = refresh === 'true' || refresh === '1';
    return force ? this.gpu.refresh() : this.gpu.status();
  }

  @Post('gpu/refresh')
  @ApiOperation({ summary: 'Force a fresh GPU probe and return the status.' })
  @ApiOkResponse({ type: GpuStatusDto })
  async refreshGpu(): Promise<GpuStatus> {
    return this.gpu.refresh();
  }

  @Get('settings')
  @ApiOperation({
    summary:
      'READ-ONLY effective server config with EVERY secret redacted, plus ' +
      'per-group guidance on how to change each setting. Global-scope ' +
      '(superadmin) surface — the panel shows config and commands, never writes.',
  })
  @ApiOkResponse({ description: '{ data: ServerSettings }' })
  getSettings(@CurrentAuth() ctx?: AuthContext): Envelope<ServerSettings> {
    this.requireGlobal(ctx);
    return ok(this.settings.getSettings());
  }

  /** Reject app-scoped principals from the global surface (no-op in dev). */
  private requireGlobal(ctx?: AuthContext): void {
    if (ctx && !ctx.isSuperadmin && ctx.scope !== 'global') {
      throw new ForbiddenException(
        'this endpoint requires a global-scope credential',
      );
    }
  }
}
