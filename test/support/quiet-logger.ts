import { Logger } from '@nestjs/common';

// Services under test log through Nest's static Logger. Test output shows
// assertions, not operational logs.
Logger.overrideLogger(false);
