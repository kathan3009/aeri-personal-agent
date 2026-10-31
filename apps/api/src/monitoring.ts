import * as Sentry from '@sentry/node';
import { createHash } from 'node:crypto';
import { scrub } from './providers.js';

/**
 * Error tracking (Sentry, when SENTRY_DSN is set) and one log line per request. Nothing personal is sent: people are
 * identified by a short hash of their id, request bodies are never attached, and messages go through `scrub`.
 */
let enabled = false;
export function initMonitoring() {
  if (!process.env.SENTRY_DSN || enabled) return;
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? 'development', release: process.env.FLY_IMAGE_REF ?? process.env.AERI_RELEASE,
    tracesSampleRate: 0,
    beforeSend: event => { if (event.request) { delete event.request.data; delete event.request.cookies; if (event.request.headers) delete event.request.headers.authorization; } return event; } });
  enabled = true;
}

export const personTag = (userId?: string) => userId ? createHash('sha256').update(userId).digest('hex').slice(0, 10) : 'anon';

export function captureError(error: unknown, context: { userId?: string; route?: string } = {}) {
  const message = scrub((error as Error)?.message ?? String(error)).slice(0, 300);
  console.error(JSON.stringify({ level: 'error', at: new Date().toISOString(), person: personTag(context.userId), route: context.route, message }));
  if (!enabled) return;
  Sentry.withScope(scope => {
    scope.setUser({ id: personTag(context.userId) });
    if (context.route) scope.setTag('route', context.route);
    Sentry.captureException(error);
  });
}

export function logRequest(entry: { method: string; route: string; status: number; ms: number; userId?: string }) {
  if (process.env.NODE_ENV !== 'production' && !process.env.AERI_REQUEST_LOG) return;
  console.log(JSON.stringify({ level: 'info', at: new Date().toISOString(), ...entry, userId: undefined, person: personTag(entry.userId) }));
}

/**
 * One structured line for something an agent did (a tool step, a run's outcome). `run` ties every line of one store
 * visit together, so "why did this fail?" is one search. Printed in production, or locally with AERI_AGENT_DEBUG.
 */
export function logEvent(event: string, fields: Record<string, unknown> & { userId?: string }) {
  if (process.env.NODE_ENV !== 'production' && !process.env.AERI_AGENT_DEBUG && !process.env.AERI_REQUEST_LOG) return;
  const { userId, ...rest } = fields;
  console.log(JSON.stringify({ level: 'info', at: new Date().toISOString(), event, person: personTag(userId), ...rest }));
}
