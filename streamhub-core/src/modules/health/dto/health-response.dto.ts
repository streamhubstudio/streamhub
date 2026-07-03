import { ApiProperty } from '@nestjs/swagger';

/** Public liveness response (SPEC §6 GET /health). */
export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: true })
  up!: true;

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ example: '2026-06-30T12:00:00.000Z' })
  ts!: string;

  @ApiProperty({ example: 1234 })
  uptimeSeconds!: number;
}
