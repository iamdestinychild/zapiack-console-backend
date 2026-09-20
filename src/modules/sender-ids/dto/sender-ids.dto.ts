import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CursorPageDto } from '../../../common/dto/common.dto';

const STATUSES = [
  'SUBMITTED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'REJECTED',
  'APPROVED',
  'SUBMITTED_TO_OPERATORS',
  'ACTIVE',
  'OPERATOR_REJECTED',
  'SUSPENDED',
] as const;

export class ListSenderIdsDto extends CursorPageDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  q?: string;

  /** Applications past their SLA target first; the queue's reason for existing. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  overdueOnly?: boolean;
}

export class AssignReviewDto {
  /** Omit to take the application yourself. */
  @IsOptional()
  @IsString()
  assigneeId?: string;
}

export class ChecklistItemDto {
  @IsString()
  key!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateChecklistDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items!: ChecklistItemDto[];
}

export class DecisionDto {
  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];

  /** Required for rejection, change requests, suspension and operator rejection. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(1000)
  reason?: string;
}

export class DocumentUrlDto {
  /** `inline` powers the in-app PDF and image preview; `attachment` downloads. */
  @IsOptional()
  @IsIn(['attachment', 'inline'])
  disposition?: 'attachment' | 'inline';
}
