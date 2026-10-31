import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a piece of work is for. Set once per request (and carried into the background jobs a request starts), so
 * usage limits and logs can be per person without passing a user through every function.
 */
export type RequestContext = { userId: string };
const storage = new AsyncLocalStorage<RequestContext>();

export const runAs = <T>(userId: string, work: () => T): T => storage.run({ userId }, work);
export const currentUserId = (): string | undefined => storage.getStore()?.userId;
