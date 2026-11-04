import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReasonDto } from '../../../common/dto/common.dto';

/** Currencies a wallet can be in today. Another one needs a payment gateway that settles in it. */
export const BILLABLE_CURRENCIES = ['NGN', 'USD'] as const;

export class SetBillingMarketDto extends ReasonDto {
  /** The owner's country, or `*` for every country without a row of its own. */
  @Matches(/^([A-Za-z]{2}|\*)$/, {
    message: 'countryCode must be a two-letter country code or *',
  })
  countryCode!: string;

  @IsIn(BILLABLE_CURRENCIES)
  currency!: string;

  @IsBoolean()
  welcomeBonusEnabled!: boolean;

  /** In `currency`. Leave out to follow the environment default. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100_000)
  welcomeBonusAmount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
