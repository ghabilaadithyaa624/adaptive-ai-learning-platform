/**
 * A minimal, programmable stand-in for the Drizzle client.
 *
 * The DB-backed suites (`tests/auth`, `tests/api`, `tests/db`) are the primary
 * authorization proof, but they skip unless a Postgres is configured. This fake
 * lets the security matrix run everywhere — in CI and on a laptop with no
 * database — by serving the handful of query shapes the auth/authz path uses,
 * while still executing the *real* `getCurrentUser`, `withAuth`, `authz` and
 * auth-route code.
 *
 * It intentionally implements only what those paths need. Anything else throws,
 * so an unnoticed new query cannot silently resolve to `[]` and make an
 * authorization test pass for the wrong reason.
 */

export interface FakeQuery {
  /** The table passed to `.from(...)` / `.insert(...)` / `.delete(...)`. */
  table: unknown;
  kind: "select" | "insert" | "delete" | "update";
  joined: boolean;
  limit: number | null;
  /** The raw Drizzle condition object handed to `.where(...)`. */
  where: unknown;
  values?: unknown;
}

export type FakeHandler = (query: FakeQuery) => unknown[];

export interface FakeDb {
  db: Record<string, unknown>;
  /** Every query the code under test issued, in order. */
  log: FakeQuery[];
  setHandler(handler: FakeHandler): void;
  reset(): void;
}

export function createFakeDb(): FakeDb {
  let handler: FakeHandler = () => [];
  const log: FakeQuery[] = [];

  function builder(query: FakeQuery) {
    const resolve = () => {
      log.push(query);
      return handler(query);
    };
    const chain: Record<string, unknown> = {
      from(table: unknown) {
        query.table = table;
        return chain;
      },
      innerJoin(_table: unknown, _on: unknown) {
        query.joined = true;
        return chain;
      },
      leftJoin(_table: unknown, _on: unknown) {
        query.joined = true;
        return chain;
      },
      where(condition: unknown) {
        query.where = condition;
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(n: number) {
        query.limit = n;
        return chain;
      },
      values(v: unknown) {
        query.values = v;
        return chain;
      },
      set(v: unknown) {
        query.values = v;
        return chain;
      },
      returning() {
        return chain;
      },
      onConflictDoNothing() {
        return chain;
      },
      onConflictDoUpdate() {
        return chain;
      },
      // Thenable: awaiting the builder executes the query, exactly like Drizzle.
      then(onFulfilled?: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) {
        try {
          return Promise.resolve(resolve()).then(onFulfilled, onRejected);
        } catch (error) {
          return Promise.reject(error).then(onFulfilled, onRejected);
        }
      },
      catch(onRejected?: (reason: unknown) => unknown) {
        return (chain.then as (a?: unknown, b?: unknown) => Promise<unknown>)(undefined, onRejected);
      },
    };
    return chain;
  }

  const db = {
    select: () => builder({ table: null, kind: "select", joined: false, limit: null, where: null }),
    insert: (table: unknown) => builder({ table, kind: "insert", joined: false, limit: null, where: null }),
    delete: (table: unknown) => builder({ table, kind: "delete", joined: false, limit: null, where: null }),
    update: (table: unknown) => builder({ table, kind: "update", joined: false, limit: null, where: null }),
    execute: async () => ({ rows: [] }),
  };

  return {
    db,
    log,
    setHandler(next: FakeHandler) {
      handler = next;
    },
    reset() {
      log.length = 0;
      handler = () => [];
    },
  };
}

/**
 * Collect the column names referenced by a Drizzle condition tree.
 *
 * Used to assert that a security-critical predicate (e.g. the session expiry
 * filter) is actually present in the production query, which a fake database
 * cannot otherwise prove.
 */
export function columnsInCondition(condition: unknown, depth = 0): string[] {
  const found: string[] = [];
  if (!condition || depth > 10) return found;
  if (Array.isArray(condition)) {
    for (const entry of condition) found.push(...columnsInCondition(entry, depth + 1));
    return found;
  }
  if (typeof condition !== "object") return found;
  const node = condition as Record<string, unknown>;
  if (typeof node.name === "string" && node.table) found.push(node.name);
  if (Array.isArray(node.queryChunks)) found.push(...columnsInCondition(node.queryChunks, depth + 1));
  return found;
}
