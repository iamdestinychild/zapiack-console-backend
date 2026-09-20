import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RiskFlagType, RiskSeverity } from '../../../generated/admin/client';
import {
  CursorPageDto,
  DateRangePageDto,
  ReasonDto,
} from '../../../common/dto/common.dto';

export class SearchCustomersDto extends CursorPageDto {
  /** Matched against email, phone, business name, account id, API key prefix or sender ID. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'CLOSED'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

  @IsOptional()
  @IsString()
  planId?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  flaggedOnly?: boolean;
}

export class CustomerUsageDto extends DateRangePageDto {
  @IsOptional()
  @IsString()
  channel?: string;
}

export class SuspendCustomerDto extends ReasonDto {}

export class ChangePlanDto extends ReasonDto {
  @IsString()
  planId!: string;
}

export class RevokeKeyDto extends ReasonDto {
  @IsString()
  apiKeyId!: string;
}

/** PII reveal is permissioned, reason-bound and audited field by field. */
export class RevealPiiDto extends ReasonDto {
  @IsArray()
  @IsIn(['email', 'phone', 'ip', 'users', 'kyc'], { each: true })
  fields!: ('email' | 'phone' | 'ip' | 'users' | 'kyc')[];
}

export class CreateNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class CreateRiskFlagDto extends ReasonDto {
  // Validated against the same enum the database column uses, so the two cannot drift.
  @IsEnum(RiskFlagType)
  type!: RiskFlagType;

  @IsEnum(RiskSeverity)
  severity!: RiskSeverity;

  @IsString()
  @MaxLength(500)
  summary!: string;
}

export class CreditAdjustmentDto extends ReasonDto {
  @IsIn(['CREDIT', 'DEBIT'])
  direction!: 'CREDIT' | 'DEBIT';

  /** Naira as a decimal string; money never travels as a float. */
  @IsNumberString({ no_symbols: false })
  amountNgn!: string;
}
