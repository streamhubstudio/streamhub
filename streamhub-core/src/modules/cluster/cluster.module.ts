import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';
import { NodeRoleService } from './node-role.service';

/**
 * Cluster / edge-node registration module (one-liner installer) + the DB-driven
 * node ROLE model (standalone|master|edge) and standalone↔cluster conversion.
 *
 * Imports SecurityModule so the controller can report a failed cluster-token
 * check to the in-app auto-ban (IpReputationService). Exports NodeRoleService so
 * the auth module can lock login on an edge (CLUSTER-ROADMAP §5).
 */
@Module({
  imports: [SecurityModule],
  controllers: [ClusterController],
  providers: [ClusterService, NodeRoleService],
  exports: [ClusterService, NodeRoleService],
})
export class ClusterModule {}
