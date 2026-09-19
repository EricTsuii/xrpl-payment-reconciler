import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { PAYMENT_LIST_MAX_LIMIT, UINT32_MAX } from '../../common/constants';

/** GET /v1/payments query. Unknown keys are rejected by the global pipe. */
export class ListPaymentsDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(UINT32_MAX)
  destinationTag?: number;

  @IsOptional()
  @IsIn(['XRP', 'ISSUED_CURRENCY'])
  assetType?: 'XRP' | 'ISSUED_CURRENCY';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}
