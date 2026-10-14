import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DateRangePageDto } from '../../../common/dto/common.dto';

export class ListMessagesDto extends DateRangePageDto {
  @IsOptional()
  @IsIn(['SMS', 'EMAIL'])
  channel?: 'SMS' | 'EMAIL';

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  /** The template's row id, for "everything sent with this template". */
  @IsOptional()
  @IsString()
  templateId?: string;

  /** Words in the message (an email's subject, an SMS's text). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
