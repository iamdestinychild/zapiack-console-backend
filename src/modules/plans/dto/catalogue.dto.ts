import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IntersectionType, OmitType, PartialType } from '@nestjs/swagger';
import { BillingType, ChannelType } from '../../../generated/zapiack/client';
import { ReasonDto } from '../../../common/dto/common.dto';

/** Products are the billable lines. One per channel — the channel is unique. */
export class UpsertProductDto extends ReasonDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsIn(Object.values(ChannelType))
  channel!: ChannelType;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(Object.values(BillingType), { each: true })
  billingTypes!: BillingType[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Credits charged per send, per product per destination country. */
export class UpsertProductPricingDto extends ReasonDto {
  @IsString()
  productId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(2)
  countryCode!: string;

  @IsNumberString()
  creditCost!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,9}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Plans as the product stores them: quotas and naira prices, not per-unit pricing. */
export class UpsertPlanDto extends ReasonDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** Lowercase words joined by hyphens; unique across plans. */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(SLUG, { message: 'slug must be lowercase words joined by hyphens' })
  slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @IsString()
  type!: string;

  @IsIn(Object.values(ChannelType))
  channel!: ChannelType;

  @IsOptional()
  @IsIn(['MONTHLY', 'YEARLY'])
  billingInterval?: string;

  /** Naira, up to two decimals. Never negative. */
  @IsNumberString()
  @Matches(MONEY, {
    message: 'basePrice must be an amount like 5000 or 5000.50',
  })
  basePrice!: string;

  @IsNumberString()
  @Matches(MONEY, {
    message: 'overagePrice must be an amount like 12 or 12.50',
  })
  overagePrice!: string;

  @IsOptional()
  @IsBoolean()
  overageEnabled?: boolean;

  @IsNumberString()
  @Matches(WHOLE, { message: 'monthlyQuota must be a whole number' })
  monthlyQuota!: string;

  @IsOptional()
  @IsNumberString()
  @Matches(WHOLE, { message: 'dailyQuota must be a whole number' })
  dailyQuota?: string;

  @IsOptional()
  @IsNumberString()
  @Matches(WHOLE, { message: 'maxContacts must be a whole number' })
  maxContacts?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;
}

/**
 * Edit a plan. Every field is optional and only the ones sent are changed.
 * Send `dailyQuota: null` to remove the daily cap. Visibility and retirement have their
 * own endpoints, so `isActive` is not accepted here.
 */
export class UpdatePlanDto extends IntersectionType(
  ReasonDto,
  PartialType(OmitType(UpsertPlanDto, ['id', 'reason', 'isActive'] as const)),
) {}

/** Show a plan to new customers, or hide it from them. Existing subscribers are untouched. */
export class PlanVisibilityDto extends ReasonDto {
  @IsBoolean()
  isPublic!: boolean;
}
