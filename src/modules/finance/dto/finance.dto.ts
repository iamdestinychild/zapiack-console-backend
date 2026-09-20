import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { DateRangeDto } from '../../../common/dto/common.dto';

const GROUPS = ['channel', 'account', 'country', 'provider', 'plan'] as const;

export class FinanceQueryDto extends DateRangeDto {
  @IsOptional()
  @IsArray()
  @IsIn(GROUPS, { each: true })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  groupBy?: (typeof GROUPS)[number][];

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  provider?: string;
}

export class CreateExportDto {
  @IsIn(['revenue', 'profit', 'cash', 'ledger', 'customers', 'audit', 'usage'])
  kind!: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  accountId?: string;
}
