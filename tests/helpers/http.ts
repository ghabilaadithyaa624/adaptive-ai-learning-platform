/**
 * Request/response helpers for driving route handlers directly (no HTTP server).
 *
 * Route handlers accept a Web `Request` and return a Web `Response`
 * (`NextResponse`), so we can invoke them in-process with a constructed Request
 * and read the JSON/status off the returned Response.
 */

export type BuildOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  /** When true, simulate a cross-site browser request (fails CSRF on mutations). */
  crossSite?: boolean;
  searchParams?: Record<string, string | number | undefined>;
};

const ORIGIN = "http://localhost:3000";

export function buildRequest(method: string, path: string, opts: BuildOptions = {}): Request {
  const url = new URL(path, ORIGIN);
  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers = new Headers(opts.headers);
  headers.set("host", "localhost:3000");
  if (opts.crossSite) {
    headers.set("sec-fetch-site", "cross-site");
    headers.set("origin", "https://evil.example.com");
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }
  return new Request(url.toString(), { method, headers, body });
}

export const GET = (path: string, opts?: BuildOptions) => buildRequest("GET", path, opts);
export const POST = (path: string, opts?: BuildOptions) => buildRequest("POST", path, opts);
export const PATCH = (path: string, opts?: BuildOptions) => buildRequest("PATCH", path, opts);
export const DELETE = (path: string, opts?: BuildOptions) => buildRequest("DELETE", path, opts);

/** Build the second argument Next passes to dynamic-segment handlers. */
export function routeCtx(id: string | number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
