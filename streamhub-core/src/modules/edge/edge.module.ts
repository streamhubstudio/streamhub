import { forwardRef, Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { ClusterModule } from '../cluster/cluster.module';
import { PluginsModule } from '../plugins/plugins.module';
import { VisionAppsModule } from '../vision-apps/vision-apps.module';
import { EdgeAppController } from './edge-app.controller';
import { EdgeAssignmentsRepository } from './edge-assignments.repository';
import { EdgeCapacityAlerter } from './edge-capacity-alerter';
import { EdgeController } from './edge.controller';
import { EdgeGateway } from './edge.gateway';
import { EDGE_NOTIFIER, DefaultEdgeNotifier } from './edge-notifier';
import { EdgeReconcileService } from './edge-reconcile.service';
import { EdgeSchedulerService } from './edge-scheduler.service';
import { EdgeWatchdogService } from './edge-watchdog.service';
import { GenericSpawnResolver } from './generic-spawn.resolver';

/**
 * EDGE cluster module — the cluster's PROCESSING concept (Edge-as-capability).
 *
 * Wires the outbound WS control channel (gateway) + the assignment store + the
 * RR/weighted scheduler + the liveness/failover watchdog + the GLOBAL manager
 * REST surface (EdgeController) + the APP-SCOPED generic assignments API
 * (EdgeAppController) + the generic per-stream reconcile (EdgeReconcileService) +
 * the generic spawn resolver (GenericSpawnResolver, registered on the
 * edge.protocol seam) + the node-event notifier seam ({@link EDGE_NOTIFIER}).
 *
 * Imports: ClusterModule ({@link ClusterService} — telemetry persisted to
 * `nodes.stats_json`), PluginsModule (registry + install repo, so the resolver/
 * reconcile/API resolve edge-capable plugins), AppsModule (APPS_SERVICE).
 * Config/Db/Logs/Callbacks are @Global.
 *
 * Additionally HOSTS the vision Studio-Apps module ({@link VisionAppsModule}) so
 * its `/apps/:app/plugins/:visionApp` surface loads without touching the
 * scaffolder-owned app.module.ts. VisionAppsModule depends back on the edge
 * scheduler/repo/gateway, so this is a module cycle resolved with forwardRef on
 * both sides (no provider cycle — the edge services never inject vision). Those
 * three services are exported for the vision module to consume.
 */
@Module({
  imports: [
    ClusterModule,
    PluginsModule,
    AppsModule,
    forwardRef(() => VisionAppsModule),
  ],
  controllers: [EdgeController, EdgeAppController],
  providers: [
    EdgeGateway,
    EdgeAssignmentsRepository,
    EdgeCapacityAlerter,
    EdgeSchedulerService,
    EdgeWatchdogService,
    EdgeReconcileService,
    // Generic edge spawn resolver: registers on the edge.protocol seam so every
    // edge-capable plugin resolves through its own worker.spawn (no per-plugin
    // special-case), with the framework STREAMHUB_* edge env injected.
    GenericSpawnResolver,
    { provide: EDGE_NOTIFIER, useClass: DefaultEdgeNotifier },
  ],
  exports: [EdgeSchedulerService, EdgeAssignmentsRepository, EdgeGateway],
})
export class EdgeModule {}
