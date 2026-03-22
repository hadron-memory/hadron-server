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

# Generate client, run migrations, then start — all at runtime when DATABASE_URL is available
CMD ["doppler", "run", "--", "sh", "-c", "pnpm prisma generate && pnpm prisma db push && pnpm tsx src/index.ts"]
