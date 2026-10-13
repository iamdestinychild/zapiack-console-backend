import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CursorPageDto } from '../../../common/dto/common.dto';
import { TEMPLATE_STATUSES } from '../template-rules';

/**
 * `PENDING` is the review queue (submitted, or held by the automated checks).
 * `ALL` is every status. Anything else is one status on its own, including `DRAFT`.
 */
const FILTERS = ['PENDING', 'ALL', ...TEMPLATE_STATUSES] as const;

export class ListTemplatesDto extends CursorPageDto {
  @IsOptional()
  @IsIn(FILTERS)
  status?: (typeof FILTERS)[number];

  /** Matches name, slug, subject, template id, account id and project name. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
