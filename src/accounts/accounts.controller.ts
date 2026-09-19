import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiError } from '../common/errors/api-error';
import type { AccountWithCursor } from './accounts.repository';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';

function uuidPipe(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => new ApiError('VALIDATION_ERROR', 'id must be a UUID'),
  });
}

function presentAccount(account: AccountWithCursor, withReconciledAt: boolean) {
  return {
    id: account.id,
    networkId: account.networkId,
    address: account.address,
    label: account.label,
    enabled: account.enabled,
    lastReconciledLedger: account.lastReconciledLedger,
    ...(withReconciledAt
      ? { lastReconciledAt: account.lastReconciledAt?.toISOString() ?? null }
      : {}),
    createdAt: account.createdAt.toISOString(),
  };
}

@Controller('v1/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  async create(@Body() dto: CreateAccountDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { created, account } = await this.accounts.activate(dto);
    void reply.status(created ? 201 : 200);
    return { data: presentAccount(account, false) };
  }

  @Get()
  async list() {
    const rows = await this.accounts.list();
    return { data: { items: rows.map((row) => presentAccount(row, true)) } };
  }

  @Delete(':id')
  @HttpCode(204)
  async disable(@Param('id', uuidPipe()) id: string): Promise<void> {
    await this.accounts.disable(id);
  }
}
