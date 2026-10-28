FROM node:22-alpine
RUN apk add --no-cache git curl gnupg && \
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://cli.doppler.com/install.sh' | sh && \
    apk del curl gnupg
# pnpm 11 (matches the `packageManager` field in package.json — corepack
# honors that field over any version prepared here, so keep them in sync).
# The build-script allowlist for native artifacts (Prisma engines/client,
# bcrypt node-gyp, esbuild) lives in `pnpm-workspace.yaml` under `allowBuilds:`
# — pnpm 11 no longer reads `package.json`'s `pnpm.onlyBuiltDependencies`. That
# file MUST be copied before `pnpm install`, otherwise the build scripts are
# ignored and the install fails with ERR_PNPM_IGNORED_BUILDS (the error only
# surfaces here, not in CI, because GitHub Actions sets CI=true which downgrades
# it to a warning).
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
WORKDIR /app

# Install dependencies. pnpm-workspace.yaml carries the build-script allowlist
# and must be present at install time (see note above).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY prisma ./prisma/
COPY prisma.config.ts ./

# Copy source
COPY tsconfig.json ./
COPY src ./src/
COPY scripts ./scripts/

ENV NODE_ENV=production
EXPOSE 10300

# Generate client, apply any pending migrations, then start — all at runtime
# when DATABASE_URL is available. `migrate deploy` is the production-grade
# command: it applies only the migration files in prisma/migrations/ that
# haven't been recorded yet, is deterministic, and never prompts. Do NOT
# replace this with `db push` — that's a dev-mode tool that compares the
# live schema to schema.prisma and will block on any drift.
CMD ["doppler", "run", "--", "sh", "scripts/docker-start.sh"]
