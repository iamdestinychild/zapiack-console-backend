import { IsIn, IsOptional, IsString } from 'class-validator';
import { CursorPageDto } from '../../../common/dto/common.dto';

const STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'APPLIED',
  'REJECTED',
  'FAILED',
] as const;

export class ListCreditAdjustmentsDto extends CursorPageDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}
