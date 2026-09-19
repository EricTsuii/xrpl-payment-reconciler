import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService, APP_CONFIG_KEY } from './config.service';
import { validateConfig } from './config.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      ignoreEnvFile: false,
      cache: true,
      validate: (env) => ({ [APP_CONFIG_KEY]: validateConfig(env) }),
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
