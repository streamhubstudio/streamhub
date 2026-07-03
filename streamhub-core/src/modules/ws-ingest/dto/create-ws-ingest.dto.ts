import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Body of POST /apps/:app/ws-ingest (mint a wsk_ camera key). */
export class CreateWsIngestDto {
  @ApiProperty({
    description:
      'Room the camera publishes into (namespaced under the app prefix).',
    example: 'cam1',
  })
  @IsString()
  @MaxLength(64)
  @Matches(SLUG, {
    message: 'room must be alphanumeric with dashes/underscores',
  })
  room!: string;

  @ApiPropertyOptional({
    description:
      'Participant identity of the camera (default: wscam-<key suffix>).',
    example: 'porton-norte',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(SLUG, {
    message: 'identity must be alphanumeric with dashes/underscores',
  })
  identity?: string;
}
