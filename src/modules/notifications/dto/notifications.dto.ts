import { Type } from 'class-transformer';
import {
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CursorPageDto, ReasonDto } from '../../../common/dto/common.dto';

/** Declarative audience filter, compiled to a read against the Zapiack DB. */
/** The states an account can be in. `CLOSED` was never one of them. */
const ACCOUNT_STATUSES = [
  'ACTIVE',
  'PAST_DUE',
  'PROBATION',
  'SUSPENDED',
  'CANCELED',
  'BANNED',
] as const;

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'VOICE', 'AUDIO'] as const;

/**
 * Who a segment matches. Every field narrows the audience, they combine with AND, and
 * an empty filter means every account. A segment stores this, not a list of accounts,
 * so a campaign sent tomorrow reaches whoever matches tomorrow.
 */
export class SegmentFilterDto {
  /** Accounts subscribed to any of these plans (active subscriptions only). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  planIds?: string[];

  @IsOptional()
  @IsArray()
  @IsIn(ACCOUNT_STATUSES, { each: true })
  statuses?: string[];

  /** ISO country codes of the account, e.g. `["NG", "GH"]`. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  countries?: string[];

  /** Credit balance below this many CREDITS (not naira). */
  @IsOptional()
  @IsNumber()
  creditsBelow?: number;

  /**
   * @deprecated The name says naira but the balance is credits. Same as `creditsBelow`;
   * kept so existing saved segments and screens keep working.
   */
  @IsOptional()
  @IsNumber()
  balanceBelowNgn?: number;

  /** No message sent in this many days. Includes accounts that never sent one. */
  @IsOptional()
  @IsInt()
  @Min(1)
  inactiveForDays?: number;

  /** Accounts that have sent on this channel at least once. */
  @IsOptional()
  @IsIn(CHANNELS)
  usedChannel?: string;

  /** Whether the account owner has verified their email address. */
  @IsOptional()
  @IsBoolean()
  emailVerified?: boolean;

  /**
   * Not available: the product records no KYC status. Refused with a clear message
   * rather than quietly ignored, which would send to everyone.
   */
  @IsOptional()
  @Equals(undefined, {
    message:
      'kycVerified is not available: the product does not record KYC. Use emailVerified instead.',
  })
  kycVerified?: boolean;
}

const CAMPAIGN_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'SCHEDULED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
] as const;

export class ListCampaignsDto extends CursorPageDto {
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES)
  status?: (typeof CAMPAIGN_STATUSES)[number];
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
