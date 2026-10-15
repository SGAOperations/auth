import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

// Node only: nothing that runs on the edge runtime may import this module.

export type RequestContext = {
  requestId: string;
  route: string;
  method: string;
  path: string;
  userId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** No-op outside a request. Callers pass a user id, never an email. */
export function setRequestUserId(userId: string): void {
  const store = storage.getStore();
  if (store) store.userId = userId;
}
