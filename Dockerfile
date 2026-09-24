# syntax=docker/dockerfile:1

# ---- deps: install production + build dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js standalone server ----
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL is only needed at runtime; a dummy value lets the build's static
# analysis pass without contacting a database.
ENV DATABASE_URL="postgres://build:build@localhost:5432/build"
RUN npm run build

# ---- runner: minimal, non-root runtime image ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Run as an unprivileged user.
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nextjs

# Standalone server + static assets + public files.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Container-level liveness check hits the app's readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# NOTE: run database migrations (`npm run db:migrate`) as a separate deploy step
# before starting new app containers — see OPERATIONS.md.
CMD ["node", "server.js"]
