import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
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

/** Plans as the product stores them: quotas and naira prices, not per-unit pricing. */
export class UpsertPlanDto extends ReasonDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
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

  @IsNumberString()
  basePrice!: string;

  @IsNumberString()
  overagePrice!: string;

  @IsOptional()
  @IsBoolean()
  overageEnabled?: boolean;

  @IsNumberString()
  monthlyQuota!: string;

  @IsOptional()
  @IsNumberString()
  dailyQuota?: string;

  @IsOptional()
  @IsNumberString()
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
