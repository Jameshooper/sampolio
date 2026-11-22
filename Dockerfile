# Sampolio container image. Build: docker build -t sampolio .
# Run (data on a host volume; secrets from an env file that is never baked in):
#   docker run -p 3999:3999 -v "$PWD/sampolio-data:/app/data" --env-file .env sampolio
# The base image is pinned by digest in both stages for reproducible builds;
# Dependabot (docker ecosystem) proposes digest updates.

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder
WORKDIR /app
# Same pnpm as package.json "packageManager" (Node 25+ no longer bundles corepack).
RUN npm install -g pnpm@12.3.4
# .dockerignore keeps .env*, data/, .git and local build output out of the context.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data
COPY --from=builder --chown=node:node /app ./
# Run as the image's unprivileged `node` user (uid 1000); the data dir is
# private to it. A bind-mounted host directory must be writable by uid 1000.
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 3999
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3999", "-H", "0.0.0.0"]
