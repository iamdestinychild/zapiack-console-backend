import { IsBoolean, IsOptional } from 'class-validator';
import { CursorPageDto } from '../../../common/dto/common.dto';
import { BooleanQuery } from '../../../common/dto/query-transforms';

/**
 * A real class, not an intersection type.
 *
 * `@Query() q: CursorPageDto & { ... }` compiles to `design:type = Object`, so
 * ValidationPipe never runs and `limit` stays the string it arrived as — which then
 * concatenates instead of adding and reaches Prisma as `"401"`.
 */
export class ListInboxDto extends CursorPageDto {
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  unreadOnly?: boolean;
}
