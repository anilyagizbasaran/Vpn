import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { isProduction } from '../config/env.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.path}`));
};

interface ExposedClientError {
  status?: number;
  statusCode?: number;
}

/**
 * True for middleware errors that are already safe to show the client — the
 * `expose` flag is how body-parser and friends mark a 4xx they authored.
 */
function isExposedClientError(error: unknown): error is ExposedClientError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { expose?: unknown; status?: unknown; statusCode?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return (
    candidate.expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error('request failed', {
        requestId: req.requestId,
        code: error.code,
        message: error.message,
      });
    }
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  // body-parser rejects malformed JSON, oversized bodies and bad charsets with
  // errors carrying `status` and `expose: true`. Without this they would all
  // surface as a 500 with a stack trace in the logs, hiding real failures.
  if (isExposedClientError(error)) {
    const status = error.status ?? error.statusCode ?? 400;
    res.status(status).json({
      error: {
        code: status === 413 ? 'payload_too_large' : 'bad_request',
        message:
          status === 413
            ? 'Request body is too large'
            : 'Request body is not valid JSON',
      },
    });
    return;
  }

  logger.error('unhandled error', {
    requestId: req.requestId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong',
      // Never leak internals (command output, SQL, paths) to clients in prod.
      ...(isProduction
        ? {}
        : { details: error instanceof Error ? error.message : String(error) }),
    },
  });
};
