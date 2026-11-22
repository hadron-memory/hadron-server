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

# #851 (cor:api:270:01): READINESS, not liveness. `GET /ready` answers 200 only once the first startup has settled and
# the database answers (503 starting / startup_failed / stopping / database_unavailable otherwise), so this check reports
# whether the container should receive traffic. The status is a readiness signal ONLY: nothing may restart or replace the
# container on `unhealthy`. Liveness stays `/health`, which a failed first sync does not fail, precisely so a degraded
# boot is never turned into a restart loop.
# DEPLOY CONSEQUENCE, read before shipping this image: a reader of the Docker health status acts on it. Traefik's Docker
# provider drops a container that is `starting` or `unhealthy` from routing with no extra configuration, so under that
# provider this check IS the routing gate (a database outage longer than start-period-free retries x interval, about
# 75 s, takes the replica out of rotation: clients get Traefik's 404 instead of the app's 503). Docker Swarm would
# instead REPLACE an unhealthy task, the restart loop ruled out above, so this service must not run under Swarm's health
# handling. Plain Docker Compose or a single container only records the status. The probe follows the container's PORT
# (the server's own default, 4000, when unset) and treats anything but 200, including no connection, as not ready. The
# boot-time generate/migrate/transpile runs before the port opens, hence the generous start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

# Generate client, apply any pending migrations, then start — all at runtime
# when DATABASE_URL is available. `migrate deploy` is the production-grade
# command: it applies only the migration files in prisma/migrations/ that
# haven't been recorded yet, is deterministic, and never prompts. Do NOT
# replace this with `db push` — that's a dev-mode tool that compares the
# live schema to schema.prisma and will block on any drift.
CMD ["doppler", "run", "--", "sh", "scripts/docker-start.sh"]
