# admin-core production image.
#
# Debian slim rather than Alpine: Prisma's engines want glibc and OpenSSL, and the
# musl variants are a recurring source of "works locally, fails on the droplet".

# ---------------------------------------------------------------- deps
FROM node:22-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Prisma's postinstall fetches engines, so scripts stay enabled here.
RUN npm ci

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app

COPY tsconfig*.json nest-cli.json prisma.admin.config.ts prisma.zapiack.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Generates both Prisma clients into src/generated, then compiles.
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3001
# `all` runs web and workers in one process; compose overrides it per container.
ENV ADMIN_ROLE=all

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Kept in the image so `migrate deploy` can run as a one-shot container from it.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.admin.config.ts ./prisma.admin.config.ts

# GeoLite2 is mounted at runtime, not baked in: it is licensed and refreshed weekly.
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# Node is PID 1 here and handles SIGTERM itself; Nest's shutdown hooks drain on it.
CMD ["node", "dist/main.js"]
