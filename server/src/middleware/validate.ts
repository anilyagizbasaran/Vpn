import type { z } from 'zod';
import { badRequest } from '../utils/errors.js';

/** Parses a request body, turning zod issues into a 400 with field details. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  throw badRequest(
    'Request body failed validation',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  );
}

/**
 * Parses a numeric path parameter such as `/devices/:id`. Takes `unknown`
 * because Express types params as `string | string[] | undefined` — a repeated
 * parameter arrives as an array and must be rejected, not coerced.
 */
export function parseIdParam(value: unknown, name = 'id'): number {
  if (typeof value !== 'string') {
    throw badRequest(`Path parameter "${name}" must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest(`Path parameter "${name}" must be a positive integer`);
  }
  return parsed;
}
