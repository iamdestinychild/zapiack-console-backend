import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** `from` / `to` are Africa/Lagos calendar dates, inclusive at both ends. */
export class DateRangeDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class CursorPageDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

export class DateRangePageDto extends CursorPageDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** Sensitive actions carry a written reason, stored verbatim in the audit log. */
export class ReasonDto {
  @IsString()
  @MinLength(8, {
    message: 'reason must explain the action in at least 8 characters',
  })
  @MaxLength(1000)
  reason!: string;
}
