import type { ErrorCode, SupportFeature } from './types.js';

/** Error thrown by the functions of @browser-lite/core; `code` tells what went wrong. */
export class BrowserLiteError extends Error {
  /** Machine readable reason. */
  readonly code: ErrorCode;
  /** For `unsupported`: the missing host browser features. */
  readonly missing?: SupportFeature[];

  constructor(
    code: ErrorCode,
    message: string,
    options?: { missing?: SupportFeature[]; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrowserLiteError';
    this.code = code;
    if (options?.missing) this.missing = options.missing;
  }
}
