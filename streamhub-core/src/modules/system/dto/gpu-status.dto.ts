import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GpuDevice, GpuStatus, GpuType } from '../gpu.types';

/** One acceleration-capable device (Swagger view of {@link GpuDevice}). */
export class GpuDeviceDto implements GpuDevice {
  @ApiProperty({ enum: ['nvidia', 'vaapi'], example: 'nvidia' })
  kind!: 'nvidia' | 'vaapi';

  @ApiProperty({ example: 'NVIDIA GeForce RTX 3090' })
  name!: string;

  @ApiPropertyOptional({ example: 0 })
  index?: number;

  @ApiPropertyOptional({ example: 24576, description: 'Total memory (MiB).' })
  memoryMiB?: number;
}

/** GPU detection result (Swagger view of {@link GpuStatus}). */
export class GpuStatusDto implements GpuStatus {
  @ApiProperty({ example: false, description: 'A usable GPU was detected.' })
  available!: boolean;

  @ApiProperty({ enum: ['nvidia', 'vaapi', 'none'], example: 'none' })
  type!: GpuType;

  @ApiProperty({ type: [GpuDeviceDto] })
  devices!: GpuDeviceDto[];

  @ApiPropertyOptional({ example: '550.90.07' })
  driver?: string;

  @ApiProperty({ example: '2026-07-01T00:00:00.000Z' })
  checkedAt!: string;

  @ApiPropertyOptional({
    example: 'no NVIDIA (nvidia-smi) and no VAAPI (/dev/dri render node)',
  })
  detail?: string;
}
