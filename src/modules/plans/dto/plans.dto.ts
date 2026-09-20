import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ReasonDto } from '../../../common/dto/common.dto';

const CHANNELS = [
  'SMS',
  'EMAIL',
  'WHATSAPP',
  'VOICE',
  'VIDEO',
  'IN_APP',
  'FACE_LIVENESS',
  'MAPPING',
] as const;

export class UpsertPlanDto extends ReasonDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(['PREPAID', 'POSTPAID', 'SUBSCRIPTION'])
  billingType!: string;

  @IsNumberString()
  priceNgn!: string;

  @IsOptional()
  @IsIn(['month', 'year'])
  interval?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * Customer-facing price per unit. Never edited in place: a change is a new row with
 * a new effective-from date, so last month's profit still reads against last month's price.
 */
export class UpsertPricingDto extends ReasonDto {
  @IsIn(CHANNELS)
  channel!: string;

  @IsOptional()
  @IsString()
  planId?: string;

  /** Set for an enterprise deal; requires effectiveTo so the deal expires. */
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  network?: string;

  @IsNumberString()
  unitPriceNgn!: string;

  @IsISO8601()
  effectiveFrom!: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;
}

/** Provider cost per unit. Lives in the Admin DB, versioned the same way. */
export class UpsertProviderCostDto extends ReasonDto {
  @IsString()
  @MaxLength(60)
  provider!: string;

  @IsIn(CHANNELS)
  channel!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  network?: string;

  @IsNumberString()
  unitCostNgn!: string;

  @IsISO8601()
  effectiveFrom!: string;

  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListPricingDto {
  @IsOptional()
  @IsIn(CHANNELS)
  channel?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  /** Defaults to today; pass a date to see the prices that applied then. */
  @IsOptional()
  @IsISO8601()
  asOf?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeHistory?: boolean;
}

export class SetMarginTargetDto extends ReasonDto {
  @IsIn(CHANNELS)
  channel!: string;

  /** 0.35 = 35%. */
  @IsNumberString()
  targetMargin!: string;

  @IsISO8601()
  effectiveFrom!: string;
}
