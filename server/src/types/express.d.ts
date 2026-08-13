import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; absent on public routes. */
      auth?: { userId: number };
      /** Set by `requireDevice` on the enrolment paths. */
      device?: import('../db/types.js').Device;
      /** Correlation id attached to every request and every log line. */
      requestId?: string;
    }
  }
}
