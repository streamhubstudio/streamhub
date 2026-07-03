import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, MaxLength } from 'class-validator';

/** Request body of POST /teams/mine/members. Invite/attach a member. */
export class InviteMemberDto {
  @ApiProperty({ example: 'bob@example.com' })
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiPropertyOptional({
    description: "Membership role in the team. Defaults to 'viewer'.",
    enum: ['owner', 'editor', 'viewer'],
    example: 'editor',
  })
  @IsOptional()
  @IsIn(['owner', 'editor', 'viewer'])
  role?: 'owner' | 'editor' | 'viewer';
}
