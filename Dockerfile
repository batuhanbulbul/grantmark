# syntax=docker/dockerfile:1
# One container: API, mock registry, license server and the built web app.
# Devnet and test PKI only. The SQLite database lives on the /data volume.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/consent-record/package.json packages/consent-record/
COPY packages/hcs/package.json packages/hcs/
COPY packages/payments/package.json packages/payments/
COPY packages/stamp/package.json packages/stamp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Also downloads the native C2PA binary for linux-x64 (c2pa-node postinstall).
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/grantmark.db
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Seeding is idempotent, so it runs on every start.
CMD ["sh", "-c", "node_modules/.bin/tsx apps/server/src/seed-cli.ts && exec node_modules/.bin/tsx apps/server/src/main.ts"]
