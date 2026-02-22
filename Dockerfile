FROM node:20-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Generate Prisma client for the container's platform
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

# Copy source
COPY tsconfig.json ./
COPY src ./src/

ENV NODE_ENV=production
EXPOSE 4000

# Run migrations then start — prisma migrate deploy is idempotent
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/index.ts"]
