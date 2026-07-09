# syntax=docker/dockerfile:1

# ---- build ----
# Installs full deps (incl. devDependencies), generates the Prisma client
# for this schema, and compiles TypeScript. Not shipped as-is — only
# dist/ and the pruned node_modules make it into the runtime stage below.
FROM node:20-slim AS build
WORKDIR /app

# Prisma's query engine needs OpenSSL at both generate-time and runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop devDependencies now that the build artifacts exist — the pruned
# node_modules (still containing the generated Prisma client under
# node_modules/@prisma/client and node_modules/.prisma/client) is what
# gets copied into the runtime stage.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma

# Node's official image already has a non-root `node` user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Slash-command registration (npm run register-commands) and Prisma
# migrations (npm run prisma:deploy) are separate, explicit, one-off steps
# — neither is run automatically on container start. See README's
# "Migrations" section.
CMD ["node", "dist/src/server.js"]
