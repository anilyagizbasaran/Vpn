/** An error that is safe to surface to the API client. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);

export const notFound = (message = 'Resource not found') => new AppError(404, 'not_found', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, details);

/** Peer/device quota exhausted — distinct code so the app can show a paywall. */
export const quotaExceeded = (message: string, details?: unknown) =>
  new AppError(409, 'peer_quota_exceeded', message, details);

/** The `wg` CLI failed. Never leaks command output to the client. */
export const wireguardFailure = (message: string) =>
  new AppError(502, 'wireguard_error', message);
