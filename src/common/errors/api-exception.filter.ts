import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestId } from '../request-id/request-id.hook';
import { ApiError, ERROR_HTTP_STATUS, ErrorCode } from './api-error';

/**
 * Converts every failure into the public error envelope. Stack traces and
 * internal messages never reach the client.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = getRequestId(request);

    const { code, message } = this.describe(exception, requestId);
    void reply.status(ERROR_HTTP_STATUS[code]).send({ error: { code, message, requestId } });
  }

  private describe(exception: unknown, requestId: string): { code: ErrorCode; message: string } {
    if (exception instanceof ApiError) {
      return { code: exception.code, message: exception.message };
    }
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      // Unknown routes, rejected pipes and malformed input: the error code
      // list is closed, so every client-side failure is a validation error.
      return { code: 'VALIDATION_ERROR', message: validationMessage(exception) };
    }
    if (isClientTransportError(exception)) {
      // Fastify content-parser failures: malformed JSON, oversized body,
      // unsupported media type.
      return { code: 'VALIDATION_ERROR', message: 'The request body could not be accepted.' };
    }

    const error = exception instanceof Error ? exception : new Error('non-error thrown');
    this.logger.error(`request ${requestId} failed: ${error.name}: ${error.message}`, error.stack);
    return { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' };
  }
}

function validationMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message: unknown = response.message;
    if (Array.isArray(message)) {
      return message.filter((item): item is string => typeof item === 'string').join('; ');
    }
    if (typeof message === 'string') {
      return message;
    }
  }
  return exception.message;
}

function isClientTransportError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) {
    return false;
  }
  const statusCode = (exception as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
