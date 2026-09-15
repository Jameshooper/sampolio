# Sampolio — container image for self-hosted deployment (including the
# Home Assistant add-on defined by config.yaml at the repo root).
#
# Builds the same way scripts/server-deploy.sh does on the maintainer's
# machine: `pnpm install` against the real node_modules, then `next build`.
# We intentionally do NOT rely on `output: 'standalone'` — see the comment in
# next.config.ts — so the runtime stage ships full node_modules and starts
# the app with `next start`, exactly like the non-Docker deployment path.

FROM node:26-alpine AS builder
WORKDIR /app

# Node 25+ no longer bundles corepack — install the pnpm version pinned in
# package.json's packageManager field directly.
RUN npm i -g pnpm@12.3.4

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app ./
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 3999
ENTRYPOINT ["/run.sh"]
