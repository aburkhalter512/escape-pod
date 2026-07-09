# syntax=docker/dockerfile:1

# ---- build ----
# Installs full deps (incl. devDependencies) and compiles TypeScript. Not
# shipped as-is — only dist/ and the pruned node_modules make it into the
# runtime stage below.
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop devDependencies now that the build artifacts exist.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Node's official image already has a non-root `node` user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Slash-command registration (npm run register-commands) is a separate,
# explicit, one-off step against the Discord API — not run automatically
# on container start.
CMD ["node", "dist/src/server.js"]
