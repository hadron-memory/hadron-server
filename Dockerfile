FROM node:20-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma/
COPY prisma.config.ts ./

# Copy source
COPY tsconfig.json ./
COPY src ./src/

ENV NODE_ENV=production
EXPOSE 4000

# Generate client, run migrations, then start — all at runtime when DATABASE_URL is available
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && npx tsx src/index.ts"]
