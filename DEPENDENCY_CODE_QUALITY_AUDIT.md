# Final dependency and code-quality audit

Date: 2026-09-25

## Executive summary

- `npm audit`: **4 moderate findings, 0 high, 0 critical**. All four entries are one transitive advisory chain: `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild@0.18.20` (`GHSA-67mh-4wv8-2f99`).
- `npm audit --omit=dev`: **0 vulnerabilities** across the production dependency graph.
- Optimized Next.js production build: **passed**. The standalone runner contains the emitted application, static assets, and public files—not the development toolchain.
- TypeScript strict typecheck, ESLint, and targeted regression tests: **passed**.
- No `as any`, `@ts-ignore`, `@ts-expect-error`, `TODO`, or `FIXME` marker was found under `src`, `benchmarks`, or `tests`.
- Safe cleanup performed: removed unused `dotenv`, upgraded `drizzle-orm` 0.45.2→0.45.3 and `pg` 8.20.0→8.23.0, and consolidated duplicated Bloom/difficulty mappings onto the existing canonical constants.

## Vulnerability assessment

### P1 — Moderate esbuild development-server advisory

Advisory: `GHSA-67mh-4wv8-2f99`, CVSS 5.3. A malicious website can make requests to a vulnerable esbuild development server and read responses. Installed vulnerable node: `@esbuild-kit/core-utils/node_modules/esbuild@0.18.20`.

| Question | Finding |
|---|---|
| 1. Production reachable? | **No evidence of production reachability.** The chain is entirely marked `dev: true`; `npm audit --omit=dev` is clean. `drizzle-kit` is used by migration/schema scripts, not imported by application code. The Docker runner copies Next standalone output rather than `node_modules` from the build stage. No production route starts an esbuild server. |
| 2. Development-only? | **Yes.** Reachability is limited to a developer/CI environment that invokes the Drizzle tooling and, for this advisory, exposes an esbuild development server to a browser. Normal `drizzle-kit generate/migrate/push` usage does not intentionally expose such a server. |
| 3. Upgrade available? | `npm audit` reports only `drizzle-kit@0.18.1` as a fix. That is a **downgrade** from 0.31.10 and is marked semver-major by npm. Current `drizzle-kit@0.31.10` still carries the legacy loader even though it also depends on a fixed top-level esbuild. No verified non-breaking direct upgrade removes this nested version. |
| 4. Breaking change? | **Likely yes.** Forcing 0.18.1 would cross many Drizzle Kit releases and can break current schema/config behavior. Overriding the nested esbuild to an unsupported major is also not demonstrably compatible with `@esbuild-kit/core-utils`; it was not done. |
| 5. Temporary mitigation? | **Yes.** Keep Drizzle tooling development-only; never expose its/esbuild's development server on an untrusted interface; run migrations as a controlled deployment job; do not include dev dependencies in runtime images; retain the lockfile; monitor Drizzle for removal of `@esbuild-kit/esm-loader`. CI should continue reporting—not suppressing—the advisory. |

The severity is retained as **moderate**. Development-only reachability changes exposure, not the advisory's severity.

## Dependency audit

### Safe changes implemented

1. Removed direct production dependency `dotenv@17.3.1`. No source/config import exists, and Next/Node deployment already supplies environment variables.
2. Upgraded `drizzle-orm` from 0.45.2 to 0.45.3 (patch).
3. Upgraded `pg` from 8.20.0 to 8.23.0 (same major, current release).
4. Regenerated the lockfile and re-ran production audit/build/tests.

### Outdated packages not changed

- `react` / `react-dom`: 19.2.6 installed; 19.3.0 available. Kept aligned with the pinned Next toolchain pending a dedicated React/Next compatibility pass.
- `dotenv` 18 was previously reported but is now removed rather than upgraded.
- `next` 16.3.6 and `ioredis` 6.0.0 were current at audit time.

### Unused-dependency findings

`depcheck` reported `dotenv` and `react-dom` as production candidates. `dotenv` was genuinely unused and removed. `react-dom` is framework-required by Next/React even without a direct source import, so removal would be incorrect.

Reported development candidates (`typescript`, Tailwind/PostCSS packages, type packages, and coverage tooling) are used through scripts/configuration or framework compilation; static import scanners commonly miss those references. They were retained.

`embedded-postgres` is imported by `sectest/pg-server.mjs` and `perf/profile.mjs` but intentionally not declared. The performance harness explicitly documents `npm i --no-save`; the security harness therefore is not hermetic. Priority: either document the same bootstrap requirement for `sectest` or add it as a pinned dev dependency after evaluating its binary/download and license footprint.

### Duplicate/transitive dependencies

There are no duplicate direct dependency declarations. The lock graph contains multiple versions of build-time packages such as esbuild, postcss, lightningcss, picomatch, and semver because Next, Vitest/Vite, ESLint, Tailwind, and Drizzle have incompatible ranges. Blind overrides/deduplication would be unsafe. In particular, forcing esbuild deduplication would be an unsupported attempted vulnerability fix.

## Code-quality findings

### P1 — Validate persisted JSON at runtime

Several database JSON fields are converted with `as unknown as`, notably classifier parameters and experiment variants/eligibility snapshots. This is not `any`, but it trusts persisted data to match current TypeScript contracts. Corrupt, legacy, or manually edited rows can reach runtime with an invalid shape.

Recommended follow-up: add narrow runtime parsers at registry and experiment row boundaries, reject malformed versions, and emit an operational error rather than silently coercing. Do not replace casts mechanically; the safe fix requires version-aware validation and tests.

### P1 — Silent model-registry fallback

`loadClassifierUncached` catches every database/deserialization failure and returns the heuristic model without logging why. Availability is preserved, but operators may unknowingly serve a fallback model. Add a rate-limited structured warning and fallback metric while preserving current behavior. This was not changed because observability semantics should be reviewed rather than altered incidentally.

### P2 — Deprecated Next middleware convention

The production build warns that `src/middleware.ts` is deprecated in favor of the `proxy` convention. It still compiles and works under Next 16.3.6. Plan the official codemod and rerun authentication, authorization, tenant isolation, and API tests before migration; a filename/function change at this boundary is not a cosmetic cleanup.

### P2 — Unsafe/narrowing casts

No `as any` exists. Most casts are legitimate boundary adaptations (`jsonb`, DOM focus, readonly tuple narrowing). Higher-risk examples:

- persisted model and experiment JSON casts;
- `as never` in assessment-detail redaction and question workflow routes;
- generic cache casts;
- database instrumentation function wrapping.

Prioritize boundary validation. Harmless literal `as const`, test fixture casts, and proven non-empty `pop()` casts should not be churned merely to reduce cast counts.

### P2 — Duplicated configuration

Safe improvement completed: difficulty and Bloom maps in engine, seeding, model registry, and ML API now use `questions/constants.ts` as the canonical source. Backwards-compatible engine aliases remain because tutor context imports them.

Remaining intentional duplication:

- prerequisite threshold `0.6` appears in v2 selection and tutor policy/context. These represent related but not necessarily identical product semantics; consolidate only after defining whether tutor readiness and serving safety must move together.
- minimum sample thresholds differ between CTT and IRT by design and should remain separate.

### P2 — Error handling and thrown errors

Reviewed throws are primarily invariant/governance guards, test failures, UI fetch failures, dimensionality checks, and required configuration checks. They are intentional. No blanket removal is warranted.

Silent catches in auth token parsing, optional Redis rate limiting, health checks, metrics emission, and registry loading have different fail-open/fail-closed requirements. They should be audited individually. The most consequential is model-registry fallback noted above.

### P3 — Dead code and unreachable branches

ESLint/typecheck found no unreachable branch. Static dependency analysis did not establish removable application modules. Framework-discovered routes and config-driven code produce false positives for generic dead-code scanners. Exhaustive `never` branches in policy runtime are intentional compile-time guards.

### P3 — Client bundle and component size

The largest client source modules are:

- `questions-client.tsx` ~33 KB source;
- `models-client.tsx` ~21 KB;
- `paths-client.tsx` ~20 KB;
- `admin-client.tsx` ~19 KB;
- `learner-admin.tsx` ~15 KB.

They are interactive administration/editor surfaces and therefore legitimately client-side. The production build succeeded and server-heavy ML/database modules are not imported by those components. Potential later optimization: split modal/editor/analytics panels with dynamic imports and measure route chunks before changing code. Source size alone is not evidence of a bundle regression, so no speculative split was made.

`Shell` and small interaction primitives are client components because they hold navigation/UI state. Converting them requires component-boundary analysis and was not treated as an automatic cleanup.

## Prioritized follow-up

1. **Monitor/resolve the Drizzle Kit nested esbuild advisory**; preserve development-only controls and do not use `npm audit fix --force`.
2. **Add runtime schemas for persisted model/experiment JSON** and structured fallback telemetry.
3. **Migrate deprecated middleware to proxy** with the full security/tenant test matrix.
4. **Make embedded-postgres tooling reproducible** through a documented bootstrap or reviewed pinned dev dependency.
5. **Measure route-level client chunks** before splitting large admin components.
6. **Review React 19.3 compatibility** in a dedicated dependency update rather than mixing it into this audit.

## Verification performed

- `npm audit` and `npm audit --omit=dev`
- `npm outdated`
- dependency/duplicate inspection and lockfile ancestry review
- `depcheck` with manual framework/config verification
- scans for `as any`, suppression comments, TODO/FIXME, casts, catches, and throws
- strict TypeScript check
- ESLint
- targeted regression tests
- optimized Next.js production build
