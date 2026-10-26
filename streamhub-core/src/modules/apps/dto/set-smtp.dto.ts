import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Body for `PUT /apps/:app/smtp` (owner item 29). The non-secret fields are
 * written to config.yaml; `pass` goes to data/secrets.json (chmod 600), never
 * the yaml (same pattern as the S3/MQTT credentials). Omit `pass` to keep the
 * stored one. When `enabled`, app-scoped notifications (the notifier email
 * channel) use this SMTP instead of the global STREAMHUB_SMTP_* env — unless a
 * per-user override applies (precedence: user > app > global).
 */
export class SetSmtpDto {
  @ApiPropertyOptional({ description: 'Master switch.', example: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 'smtp.example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({
    example: 587,
    description: '587 = STARTTLS; 465 = implicit TLS.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ example: 'no-reply@example.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  user?: string;

  @ApiPropertyOptional({
    description: 'SMTP password — stored in secrets.json, never the yaml.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pass?: string;

  @ApiPropertyOptional({ example: 'My App <no-reply@example.com>' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  from?: string;
}
