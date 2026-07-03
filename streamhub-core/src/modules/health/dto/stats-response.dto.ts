import { ApiProperty } from '@nestjs/swagger';

class CpuStatsDto {
  @ApiProperty({ type: [Number], example: [0.5, 0.4, 0.3] })
  loadAvg!: number[];

  @ApiProperty({ example: 8 })
  cores!: number;
}

class MemoryStatsDto {
  @ApiProperty({ example: 16777216000 })
  totalBytes!: number;

  @ApiProperty({ example: 8388608000 })
  freeBytes!: number;

  @ApiProperty({ example: 8388608000 })
  usedBytes!: number;
}

class DiskStatsDto {
  @ApiProperty({ example: 500000000000 })
  totalBytes!: number;

  @ApiProperty({ example: 250000000000 })
  freeBytes!: number;

  @ApiProperty({ example: 250000000000 })
  usedBytes!: number;
}

class CountsDto {
  @ApiProperty({ example: 3 })
  apps!: number;

  @ApiProperty({ example: 2 })
  rooms!: number;

  @ApiProperty({ example: 4 })
  activeStreams!: number;
}

class EndpointStatusDto {
  @ApiProperty({ example: true })
  reachable!: boolean;

  @ApiProperty({ example: 1 })
  active!: number;

  @ApiProperty({ example: 2 })
  total!: number;
}

/** DB + VOD storage footprint (drives the Dashboard storage cards). */
class StorageStatsDto {
  @ApiProperty({ example: 262144, description: 'Global streamhub.db (+ sidecars).' })
  dbSizeBytes!: number;

  @ApiProperty({ example: 1048576, description: 'Sum of every per-app app.db.' })
  appsDbSizeBytes!: number;

  @ApiProperty({ example: 1310720, description: 'dbSizeBytes + appsDbSizeBytes.' })
  totalDbSizeBytes!: number;

  @ApiProperty({ example: 5368709120, description: 'Sum of every VOD size_bytes.' })
  vodTotalBytes!: number;

  @ApiProperty({ example: 42 })
  vodCount!: number;
}

/** Authenticated server stats response (SPEC §6 GET /stats). */
export class StatsResponseDto {
  @ApiProperty({ example: '2026-06-30T12:00:00.000Z' })
  ts!: string;

  @ApiProperty({ example: 1234 })
  uptimeSeconds!: number;

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ type: CpuStatsDto })
  cpu!: CpuStatsDto;

  @ApiProperty({ type: MemoryStatsDto })
  memory!: MemoryStatsDto;

  @ApiProperty({ type: DiskStatsDto, nullable: true })
  disk!: DiskStatsDto | null;

  @ApiProperty({ example: true })
  livekitReachable!: boolean;

  @ApiProperty({ type: CountsDto })
  counts!: CountsDto;

  @ApiProperty({ type: EndpointStatusDto })
  egress!: EndpointStatusDto;

  @ApiProperty({ type: EndpointStatusDto })
  ingress!: EndpointStatusDto;

  @ApiProperty({ type: StorageStatsDto })
  storage!: StorageStatsDto;
}
