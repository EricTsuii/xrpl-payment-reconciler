import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { ListPaymentsDto } from './dto/list-payments.dto';
import { presentPayment } from './payment.presenter';
import { PaymentsService } from './payments.service';

const HASH_PATTERN = /^[A-Fa-f0-9]{64}$/;

function uuidPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => new ApiError('VALIDATION_ERROR', 'id must be a UUID'),
  });
}

@Controller('v1/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  async list(@Query() query: ListPaymentsDto) {
    const { items, nextCursor } = await this.payments.list(query);
    return { data: { items: items.map((row) => presentPayment(row)), nextCursor } };
  }

  // Declared before ':id' so that "by-hash" is never read as an id.
  @Get('by-hash/:hash')
  async byHash(@Param('hash') hash: string) {
    if (!HASH_PATTERN.test(hash)) {
      throw new ApiError('VALIDATION_ERROR', 'hash must be 64 hexadecimal characters');
    }
    return { data: presentPayment(await this.payments.getByHash(hash), true) };
  }

  @Get(':id')
  async get(@Param('id', uuidPipe()) id: string) {
    return { data: presentPayment(await this.payments.get(id), true) };
  }
}
