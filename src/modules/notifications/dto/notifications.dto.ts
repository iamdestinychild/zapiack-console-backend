import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ReasonDto } from '../../../common/dto/common.dto';

/** Declarative audience filter, compiled to a read against the Zapiack DB. */
export class SegmentFilterDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  planIds?: string[];

  @IsOptional()
  @IsArray()
  @IsIn(['ACTIVE', 'SUSPENDED', 'CLOSED'], { each: true })
  statuses?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  countries?: string[];

  @IsOptional()
  @IsNumber()
  balanceBelowNgn?: number;

  @IsOptional()
  @IsInt()
  inactiveForDays?: number;

  /** Accounts that have used this channel at least once. */
  @IsOptional()
  @IsString()
  usedChannel?: string;

  @IsOptional()
  @IsBoolean()
  kycVerified?: boolean;
}

export class UpsertSegmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ValidateNested()
  @Type(() => SegmentFilterDto)
  filter!: SegmentFilterDto;
}

export class UpsertTemplateDto {
  @IsString()
  @MaxLength(80)
  key!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(['IN_APP', 'EMAIL', 'SMS'])
  channel!: 'IN_APP' | 'EMAIL' | 'SMS';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body!: string;
}

export class CreateCampaignDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsIn(['IN_APP', 'EMAIL', 'SMS'])
  channel!: 'IN_APP' | 'EMAIL' | 'SMS';

  @IsOptional()
  @IsString()
  templateId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body!: string;

  @IsIn(['SINGLE_ACCOUNT', 'ACCOUNT_LIST', 'SEGMENT'])
  audienceKind!: 'SINGLE_ACCOUNT' | 'ACCOUNT_LIST' | 'SEGMENT';

  @IsOptional()
  @IsString()
  segmentId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  accountIds?: string[];
}

export class ScheduleCampaignDto {
  @IsISO8601()
  scheduledAt!: string;
}

export class TestSendDto {
  /** Test sends go to the requesting staff member only. */
  @IsOptional()
  @IsString()
  sampleAccountId?: string;
}

export class ApproveCampaignDto extends ReasonDto {}
