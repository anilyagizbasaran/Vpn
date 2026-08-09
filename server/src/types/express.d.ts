import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; absent on public routes. */
      auth?: { userId: number };
      /** Correlation id attached to every request and every log line. */
      requestId?: string;
    }
  }
}
