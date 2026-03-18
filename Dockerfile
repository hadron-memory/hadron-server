FROM node:20-alpine
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
EXPOSE 4000

# Generate client, run migrations, then start — all at runtime when DATABASE_URL is available
CMD ["sh", "-c", "pnpm prisma generate && pnpm prisma db push && pnpm tsx src/index.ts"]
