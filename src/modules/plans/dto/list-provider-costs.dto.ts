import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { BooleanQuery } from '../../../common/dto/query-transforms';

const CHANNELS = [
  'SMS',
  'EMAIL',
  'WHATSAPP',
  'VOICE',
  'VIDEO',
  'IN_APP',
  'FACE_LIVENESS',
  'MAPPING',
] as const;

export class ListProviderCostsDto {
  @IsOptional()
  @IsIn(CHANNELS)
  channel?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  /** Without this only the currently effective rows are returned. */
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  includeHistory?: boolean;
}
