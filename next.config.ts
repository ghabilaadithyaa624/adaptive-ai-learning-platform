import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Conservative security headers. We intentionally do NOT set X-Frame-Options /
// frame-ancestors here so the app can still be embedded in trusted preview
// environments; add a strict frame policy in your real deployment.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) for a small,
  // production-ready Docker image. See Dockerfile.
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
