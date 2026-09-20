import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ALL_PERMISSIONS,
  type Permission,
} from '../../../common/auth/permissions';
import { CursorPageDto } from '../../../common/dto/common.dto';

export class ListStaffDto extends CursorPageDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED'])
  status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

  @IsOptional()
  @IsString()
  roleKey?: string;
}

export class InviteStaffDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  roleId!: string;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  roleId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'DISABLED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

  /** Per-staff grants layered on top of the role bundle. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  extraPermissions?: Permission[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  emailNotificationPrefs?: string[];

  @IsOptional()
  @IsBoolean()
  resetTotp?: boolean;

  @IsString()
  @MinLength(8)
  reason!: string;
}

export class UpsertRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  key!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions!: Permission[];

  /** Optional per-role network restriction, e.g. Finance only from the office. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Type(() => String)
  ipAllowlist?: string[];
}
