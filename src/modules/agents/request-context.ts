import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a request is for, available to code that is not handed the request
 * (e.g. LLM execution deep inside AI services).
 */
export interface RequestContext {
  userId: string;
  projectId?: string | null;
}

const store = new AsyncLocalStorage<RequestContext>();

export const withRequestContext = <T>(
  context: RequestContext,
  fn: () => T,
): T => store.run(context, fn);

export const currentRequest = (): RequestContext | undefined =>
  store.getStore();
