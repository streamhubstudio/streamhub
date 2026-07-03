import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../shared/auth';
import { HealthService } from './health.service';
import { HealthResponseDto } from './dto/health-response.dto';
import { StatsResponseDto } from './dto/stats-response.dto';

/** Health + stats (SPEC §6). /health is public; /stats requires auth. */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('health')
  @ApiOperation({
    summary: 'Liveness probe (public, no auth)',
    description: 'Returns up/version/ts. Used by load balancers and the UI.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    return this.health.health();
  }

  @Get('stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Server stats (auth)',
    description:
      'CPU/mem/disk, uptime, version, LiveKit reachability, counts of ' +
      'apps/rooms/active streams, and egress/ingress status.',
  })
  @ApiOkResponse({ type: StatsResponseDto })
  getStats(): Promise<StatsResponseDto> {
    return this.health.stats();
  }
}
