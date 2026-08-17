# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Syncrese
#
# Two images from one file:
#   --target runner    the application (default)
#   --target migrator  a one-shot container that applies migrations and exits
#
# They are separate because they authenticate as DIFFERENT database roles. The
# running application must not be able to alter schema or drop an RLS policy,
# so it never carries the owner credentials — a compromised app process cannot
# turn off tenant isolation.
#
# Debian slim rather than Alpine: @node-rs/argon2 ships prebuilt binaries per
# libc, and a musl mismatch surfaces as a runtime crash inside password
# hashing rather than a build error.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1


# --- dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci


# --- build -----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must not need real secrets. Anything genuinely required at boot is
# checked by src/instrumentation.ts when the container STARTS, against the
# environment it actually runs in — baking secrets into an image layer would
# put them in every registry that image is pushed to.
ENV NODE_ENV=production
RUN npm run build


# --- migrator --------------------------------------------------------------
# Keeps the full dependency tree because the runner is a TypeScript file
# executed by tsx. Runs to completion and exits; it is not a service.
FROM base AS migrator
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY drizzle ./drizzle
COPY src/db/migrate.ts ./src/db/migrate.ts
COPY src/db/schema ./src/db/schema
COPY scripts ./scripts
COPY src/lib ./src/lib
COPY tsconfig.json ./

USER node
CMD ["npx", "tsx", "src/db/migrate.ts"]


# --- runner ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root. The app writes nothing to its own filesystem — all state is in
# Postgres — so the image can stay read-only apart from the standard temp dirs.
RUN groupadd --system --gid 1001 syncrese \
 && useradd  --system --uid 1001 --gid syncrese syncrese

COPY --from=builder --chown=syncrese:syncrese /app/public ./public
COPY --from=builder --chown=syncrese:syncrese /app/.next/standalone ./
COPY --from=builder --chown=syncrese:syncrese /app/.next/static ./.next/static

USER syncrese
EXPOSE 3000

# Compose and most orchestrators restart on this. It checks the database, not
# just the socket — see src/app/api/health/route.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
