import { testEnvironment } from './environment';

// ConfigModule.forRoot validates the environment when AppModule is imported,
// so a valid test environment must exist before any test file loads.
Object.assign(process.env, testEnvironment());
