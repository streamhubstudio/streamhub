import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** Body for `PUT /apps/:app/samples/:file` (wave-4 §3). */
export class WriteSampleDto {
  @ApiProperty({ description: 'Full HTML contents of the sample file.' })
  @IsString()
  @MaxLength(500_000)
  content!: string;
}
