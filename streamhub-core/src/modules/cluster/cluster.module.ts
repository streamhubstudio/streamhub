import { Module } from '@nestjs/common';
import { ClusterController } from './cluster.controller';
import { ClusterService } from './cluster.service';

/** Cluster / edge-node registration module (one-liner installer). */
@Module({
  controllers: [ClusterController],
  providers: [ClusterService],
  exports: [ClusterService],
})
export class ClusterModule {}
