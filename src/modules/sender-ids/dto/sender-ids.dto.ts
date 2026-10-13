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
import { BooleanQuery } from '../../../common/dto/query-transforms';

import { PRODUCT_STATUSES } from '../sender-id-state';

/**
 * The statuses to filter by: the product's four. `SUBMITTED` and `IN_REVIEW` are the
 * console's old names for PENDING_REVIEW and are still accepted so an existing screen
 * keeps working; they mean exactly that.
 */
const FILTER_STATUSES = [
  ...PRODUCT_STATUSES,
  'SUBMITTED',
  'IN_REVIEW',
] as const;

/** What a reviewer can decide. CHANGES_REQUESTED is the old name for a rejection. */
const DECISIONS = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as const;

export class ListSenderIdsDto extends CursorPageDto {
  /** PENDING_REVIEW, APPROVED, REJECTED, or DRAFT (customers who have not submitted). */
  @IsOptional()
  @IsIn(FILTER_STATUSES)
  status?: (typeof FILTER_STATUSES)[number];

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  q?: string;

  /** Applications past their SLA target first; the queue's reason for existing. */
  @IsOptional()
  @BooleanQuery()
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
  /**
   * APPROVED, or REJECTED. Rejecting an approved application withdraws the approval;
   * approving a rejected one overturns the refusal. `CHANGES_REQUESTED` is accepted as
   * a rejection: the product has no such status, and a rejected application is already
   * one the customer can edit and submit again.
   */
  @IsIn(DECISIONS)
  status!: (typeof DECISIONS)[number];

  /** Required to reject: the customer is shown it. Optional when approving. */
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
