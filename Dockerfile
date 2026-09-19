# syntax=docker/dockerfile:1

# Exact version tags, written out in every stage so Dependabot can track
# them. Digest pinning and supply-chain hardening live in the separate DevOps
# repository.
ARG PNPM_VERSION=12.4.1

# --- deps: every dependency, for the build -----------------------------------
FROM node:26.8.2-bookworm-slim AS deps
ARG PNPM_VERSION
WORKDIR /app
RUN npm install --global pnpm@${PNPM_VERSION} \
 && test "$(pnpm --version)" = "${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- build: compile TypeScript to dist/ --------------------------------------
FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# --- production-deps: runtime dependencies only ------------------------------
FROM node:26.8.2-bookworm-slim AS production-deps
ARG PNPM_VERSION
WORKDIR /app
RUN npm install --global pnpm@${PNPM_VERSION} \
 && test "$(pnpm --version)" = "${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime -----------------------------------------------------------------
FROM node:26.8.2-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
