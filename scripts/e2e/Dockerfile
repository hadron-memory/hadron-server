FROM node:22.22.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates postgresql-client && rm -rf /var/lib/apt/lists/*
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
