import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a request is for, available to code that is not handed the request
 * (e.g. LLM execution deep inside AI services).
 */
export interface RequestContext {
  userId: string;
  projectId?: string | null;
  /** Answers worked out once for this request (such as project access), so repeated checks cost nothing. */
  memo?: Map<string, Promise<unknown>>;
}

const store = new AsyncLocalStorage<RequestContext>();

export const withRequestContext = <T>(
  context: RequestContext,
  fn: () => T,
): T => store.run(context, fn);

export const currentRequest = (): RequestContext | undefined =>
  store.getStore();

/**
 * Runs `compute` once per request for this key and shares the result with every later caller in the same
 * request. Outside a request it just runs. Failures are not remembered.
 */
export const requestMemo = <T>(
  key: string,
  compute: () => Promise<T>,
): Promise<T> => {
  const memo = store.getStore()?.memo;
  if (!memo) return compute();
  const known = memo.get(key);
  if (known) return known as Promise<T>;
  const pending = compute();
  memo.set(key, pending);
  pending.catch(() => memo.delete(key));
  return pending;
};
