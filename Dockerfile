FROM node:20-alpine
RUN apk add --no-cache git curl gnupg && \
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://cli.doppler.com/install.sh' | sh && \
    apk del curl gnupg
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY prisma ./prisma/
COPY prisma.config.ts ./

# Copy source
COPY tsconfig.json ./
COPY src ./src/

ENV NODE_ENV=production
EXPOSE 10300

# Generate client, apply any pending migrations, then start — all at runtime
# when DATABASE_URL is available. `migrate deploy` is the production-grade
# command: it applies only the migration files in prisma/migrations/ that
# haven't been recorded yet, is deterministic, and never prompts. Do NOT
# replace this with `db push` — that's a dev-mode tool that compares the
# live schema to schema.prisma and will block on any drift.
CMD ["doppler", "run", "--", "sh", "-c", "pnpm prisma generate && pnpm prisma migrate deploy && pnpm tsx src/index.ts"]
