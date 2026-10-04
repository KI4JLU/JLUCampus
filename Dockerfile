# syntax=docker/dockerfile:1
# Production image: the API serves the built web app from one origin.
# Built and pushed to GHCR by .github/workflows/docker.yml.

ARG NODE_VERSION=22
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION} AS bun

# Bun installs, Node runs: the design-system postinstall build calls npm.
FROM node:${NODE_VERSION}-bookworm-slim AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# git fetches the design system from its tag.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY scripts scripts
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/

FROM base AS build
# Electron is only needed for the desktop app.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Only the server's runtime dependencies; @justcampus/shared is bundled into dist.
FROM base AS deps
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @justcampus/server

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# ffmpeg and ffprobe: the transcription worker normalises, chunks and cuts audio with them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
  PORT=3000 \
  SERVE_WEB_DIR=/app/web
WORKDIR /app/apps/server
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/server/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist /app/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Apply pending migrations, then start the API.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
