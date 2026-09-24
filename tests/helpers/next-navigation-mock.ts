/**
 * Minimal `next/navigation` stand-in. The API layer signals auth failures with
 * typed HttpErrors (not redirects), but `@/lib/auth` and the page guards import
 * `redirect`/`notFound` at module load, so we provide throwing versions that are
 * easy to assert against if ever invoked.
 */
export function redirect(url: string): never {
  throw new Error(`NEXT_REDIRECT:${url}`);
}
export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
export function permanentRedirect(url: string): never {
  throw new Error(`NEXT_PERMANENT_REDIRECT:${url}`);
}
