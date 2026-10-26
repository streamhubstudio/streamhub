import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermission } from '../authz/permission.decorator';
import { FleetCommandError } from './fleet.protocol';
import { FleetInactiveError, FleetService } from './fleet.service';
import { SendCommandDto } from './dto/send-command.dto';

/** Standard StreamHub response envelope (SPEC §6). */
interface Envelope<T> {
  data: T;
  error: null;
}
function ok<T>(data: T): Envelope<T> {
  return { data, error: null };
}

/**
 * Fleet plugin API (module `fleet`). Mounted at
 * `/apps/:app/plugins/fleet/...` — deliberately using the concrete `fleet`
 * segment + distinct sub-paths (`agents`, `command`) rather than the generic
 * PluginsController `:id/data` / `:id/live` routes, because those are wired to
 * the worker live-data channel (this plugin has no worker) and Express route
 * matching between a `fleet` literal and the `:id` param is registration-order
 * dependent. Auth mirrors the rest of the plugin API: the global Bearer guard +
 * @RequirePermission on the app-config resource.
 */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'app', description: 'App name (slug).', example: 'live' })
@Controller('apps/:app/plugins/fleet')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('agents')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'Fleet data: all agents in the app + their latest metrics.',
    description:
      'The plugin DATA route. Returns { agents:[{agentId, online, status, ' +
      'version, lastSeen, ageMs, metrics:{cpu,mem,temp,uptime,cameras,disk,' +
      'relay}}], generatedAt }. Reading also wakes the MQTT subscriber for the ' +
      'app (no need to wait for the periodic reconcile).',
  })
  @ApiOkResponse({ description: 'Agents + latest metrics.' })
  async agents(@Param('app') app: string) {
    return ok(await this.fleet.getData(app));
  }

  @Get('agents/:agentId')
  @RequirePermission('config', 'read')
  @ApiOperation({
    summary: 'One agent: latest metrics + rolling history + recent commands.',
  })
  @ApiParam({ name: 'agentId', description: 'Agent id.' })
  async agent(
    @Param('app') app: string,
    @Param('agentId') agentId: string,
  ) {
    return ok(await this.fleet.getAgent(app, agentId));
  }

  @Post('command')
  @RequirePermission('config', 'write')
  @ApiOperation({
    summary: 'Publish a command to an agent (restart | ota | config | ping).',
    description:
      'Body: { agentId, command, args }. Validates the command + args (ota ' +
      'requires url/version/sha256), publishes to the agent cmd topic and ' +
      'records a PENDING command; the async result arrives on cmd/result and ' +
      'resolves it (poll GET agents/:agentId). 400 on a bad command, 409 when ' +
      'fleet has no live broker for the app.',
  })
  async command(@Param('app') app: string, @Body() body: SendCommandDto) {
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
    if (!agentId) throw new BadRequestException("body must carry an 'agentId'");
    try {
      return ok(
        await this.fleet.sendCommand(app, agentId, body.command, body.args),
      );
    } catch (err) {
      if (err instanceof FleetCommandError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof FleetInactiveError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }
}
