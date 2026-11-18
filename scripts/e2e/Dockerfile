FROM node:22.22.0-bookworm-slim
# python3/make/g++ (#3769): bcrypt ships a prebuilt binary from GitHub releases
# and node-pre-gyp falls back to a source compile when that download fails —
# bookworm-slim has no toolchain, so an unreachable/504ing release bricked the
# whole `stack.sh up` (3 of 3 attempts on orca1, 2026-11-09). The toolchain is
# dormant insurance (apt layer 107 MB -> 395 MB, ~288 MB image cost): it is only
# USED on the fallback path.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates postgresql-client python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
COPY scripts/e2e ./scripts/e2e
RUN DATABASE_URL=postgresql://e2e:e2e@db:5432/e2e pnpm prisma generate
CMD ["sh", "scripts/e2e/entrypoint.sh"]
