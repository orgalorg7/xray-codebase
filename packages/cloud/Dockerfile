# Hosted xray. Build from the repository root:
#   docker build -f packages/cloud/Dockerfile -t xray-cloud .

FROM node:24-slim AS build
ENV TURBO_TELEMETRY_DISABLED=1 CI=1
RUN npm install --global pnpm@11.9.0
WORKDIR /src
COPY . .
# Only what the server and the UI need (and the root's build tools), with a cached store.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@xray/cloud..." --filter "@xray/ui..." --filter "xray-monorepo" \
      --config.fetch-timeout=600000 --config.fetch-retries=5
RUN pnpm turbo run build --filter=@xray/cloud... --filter=@xray/ui
# A self-contained copy of the server with production dependencies only, plus the built UI.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @xray/cloud deploy --prod --legacy --config.fetch-timeout=600000 /app \
 && cp -r packages/ui/dist /app/dist/ui

FROM node:24-slim
# git fetches repositories; tini reaps the git and worker processes.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 xray \
 && mkdir /data && chown xray:xray /data
# The application stays owned by root: the server and its workers cannot change it.
COPY --from=build /app /app
WORKDIR /app
USER xray
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 XRAY_DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
