// The public error contract. Codes and their HTTP statuses are fixed.

export const ERROR_HTTP_STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_CURSOR: 400,

  ACCOUNT_NOT_FOUND: 422,

  ACCOUNT_ALREADY_MONITORED: 409,
  ACCOUNT_LIMIT_REACHED: 409,

  ACCOUNT_NOT_MONITORED: 404,
  PAYMENT_NOT_FOUND: 404,

  SERVICE_NOT_READY: 503,
  ACCOUNT_ACTIVATION_FAILED: 503,
  ACCOUNT_DISABLE_FAILED: 503,

  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as ErrorCode[];

/**
 * A failure that maps directly onto the public error contract. Anything that
 * is not an ApiError becomes INTERNAL_ERROR without exposing its message.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}
