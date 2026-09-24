/**
 * Request-scoped correlation context.
 *
 * Uses Node's `AsyncLocalStorage` so a single correlation id (and a handful of
 * request attributes) is transparently available to every log line and metric
 * emitted while handling a request — without threading an argument through the
 * whole call graph. The id survives `await` boundaries, DB calls, and the
 * adaptive engine.
 *
 * The correlation id is exposed to clients / upstream proxies via the
 * `x-request-id` response header and honoured on the way in from
 * `x-request-id` / `x-correlation-id` request headers (so a load balancer or
 * front-end trace id flows end-to-end).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RequestContext = {
  /** Correlation id echoed back as `x-request-id`. */
  requestId: string;
  method?: string;
  /** Low-cardinality route template, e.g. `/api/assessments/:id/answer`. */
  route?: string;
  userId?: number | null;
  role?: string | null;
  institutionId?: number | null;
  ip?: string | null;
  /** High-resolution start time (performance.now()) for latency accounting. */
  startedAt: number;
};

const storage = new AsyncLocalStorage<RequestContext>();

const ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Reuse a caller-supplied correlation id when it is well-formed, otherwise mint
 * a fresh UUID. Validation prevents header-injection / unbounded cardinality.
 */
export function resolveRequestId(seed?: string | null): string {
  if (seed && ID_RE.test(seed)) return seed;
  return randomUUID();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Merge additional attributes into the active context (e.g. after auth). */
export function updateContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, patch);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
