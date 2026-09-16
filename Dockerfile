# Sampolio — container image for self-hosted deployment (including the
# Home Assistant add-on defined by config.yaml at the repo root).
#
# Builds the same way scripts/server-deploy.sh does on the maintainer's
# machine: `pnpm install` against the real node_modules, then `next build`.
# We intentionally do NOT rely on `output: 'standalone'` — see the comment in
# next.config.ts — so the runtime stage ships node_modules and starts the
# app with `next start`, exactly like the non-Docker deployment path. It
# ships the *production* subset only (see the prune step below), not the
# standalone tracer output that dropped @swc/helpers.

FROM node:26-alpine AS builder
WORKDIR /app

# Node 25+ no longer bundles corepack — install the pnpm version pinned in
# package.json's packageManager field directly.
RUN npm i -g pnpm@12.3.4

# This image has no TLS of its own (next start serves plain http) — tell
# next.config.ts to drop Strict-Transport-Security/upgrade-insecure-requests,
# which otherwise make the browser rewrite every asset request to a
# nonexistent https listener and blank the page. Set before the build in
# case headers() bakes this in at build time, and again in the runner stage
# in case it's read at next start's boot instead — cheap either way.
ENV DISABLE_TLS_HEADERS=true

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Drop devDependencies (typescript, eslint, vitest/testing-library, tailwind,
# sharp, …) and pnpm's local content-addressable store now that the build
# is done — next start only needs the production dependency graph. This is
# pnpm's own lockfile-driven prune, not Next's `output: 'standalone'`
# tracer (still intentionally unused — see next.config.ts), so it doesn't
# risk that bug. Meaningfully smaller final image, which matters on
# small/fixed-storage hosts (e.g. a Home Assistant Green's eMMC).
RUN pnpm prune --prod && pnpm store prune

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DISABLE_TLS_HEADERS=true

# Optional embedded Tailscale (see run.sh) — only used when the add-on's
# tailscale_auth_key option is set. Alpine's own package keeps this in step
# with the base image's arch (aarch64/amd64) without a separate download.
RUN apk add --no-cache tailscale

COPY --from=builder /app ./
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 3999
ENTRYPOINT ["/run.sh"]
