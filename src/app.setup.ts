import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiError } from './common/errors/api-error';
import { ApiExceptionFilter } from './common/errors/api-exception.filter';
import { registerRequestIdHook } from './common/request-id/request-id.hook';
import { AppConfigService } from './config/config.service';
import { enabledLogLevels } from './config/config.validation';

/** Fastify settings: 64 KiB bodies, no proxy trust. CORS stays disabled. */
export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({ bodyLimit: 65_536, trustProxy: false });
}

/**
 * Everything main.ts applies to the application. E2E tests call the same
 * function, so they exercise the production configuration.
 */
export function configureApp(app: NestFastifyApplication): void {
  const config = app.get(AppConfigService);
  app.useLogger(
    new ConsoleLogger({ json: true, colors: false, logLevels: enabledLogLevels(config.logLevel) }),
  );
  registerRequestIdHook(app.getHttpAdapter().getInstance());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new ApiError(
          'VALIDATION_ERROR',
          errors.flatMap((error) => Object.values(error.constraints ?? {})).join('; ') ||
            'request is not valid',
        ),
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
}
