import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ReasonDto } from '../../../common/dto/common.dto';

export const AVAILABILITY_SERVICES = ['SMS'] as const;
const COUNTRY = /^([A-Za-z]{2}|\*)$/;

export class SetAvailabilityDto extends ReasonDto {
  /** The account's own country, or `*` for accounts from anywhere. */
  @Matches(COUNTRY, {
    message: 'accountCountry must be a two-letter country code or *',
  })
  accountCountry!: string;

  @IsIn(AVAILABILITY_SERVICES as unknown as string[])
  service!: string;

  /** The country messages go to, or `*` for the whole service. */
  @Matches(COUNTRY, {
    message: 'destinationCountry must be a two-letter country code or *',
  })
  destinationCountry!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
