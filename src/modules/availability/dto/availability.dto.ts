import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReasonDto } from '../../../common/dto/common.dto';

/** Products a rule can switch. */
export const AVAILABILITY_SERVICES = ['SMS', 'EMAIL', 'PUSH'] as const;
export const MESSAGE_TYPES = ['*', 'TRANSACTIONAL', 'PROMOTIONAL'] as const;
const COUNTRY = /^([A-Za-z]{2}|\*)$/;

export class AvailabilityRuleDto {
  /** The account's own country, or `*` for accounts from anywhere. */
  @Matches(COUNTRY, {
    message: 'accountCountry must be a two-letter country code or *',
  })
  accountCountry!: string;

  @IsIn(AVAILABILITY_SERVICES)
  service!: string;

  /** The country messages go to, or `*` for the whole service. */
  @Matches(COUNTRY, {
    message: 'destinationCountry must be a two-letter country code or *',
  })
  destinationCountry!: string;

  /** TRANSACTIONAL or PROMOTIONAL to speak only of that kind of SMS; `*` or nothing for every kind. */
  @IsOptional()
  @IsIn(MESSAGE_TYPES)
  messageType?: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/** What a multi-select saves: rules to create or change, and rules to take away, together. */
export class ChangeAvailabilityDto extends ReasonDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityRuleDto)
  upserts!: AvailabilityRuleDto[];

  @IsArray()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  deleteIds!: string[];
}
