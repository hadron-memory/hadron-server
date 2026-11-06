#!/usr/bin/env bash

# docker run --rm \
#   --add-host=host.docker.internal:host-gateway \
#   -e DATABASE_URL="$DATABASE_URL" \
#   --entrypoint sh \
#   ghcr.io/hadron-memory/hadron-server:latest \
#   -c "npx prisma migrate deploy"

ssh alpha 'docker exec hadron-server doppler run -- sh -c "npx prisma db push --force-reset && npx tsx prisma/seed.ts"'
