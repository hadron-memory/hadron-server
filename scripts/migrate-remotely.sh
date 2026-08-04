#!/usr/bin/env bash

# docker run --rm \
#   --add-host=host.docker.internal:host-gateway \
#   -e DATABASE_URL="postgresql://hadron:71875b2ac2baa11ac45b5ee547a061e888307718@host.docker.internal:5432/hadron" \
#   --entrypoint sh \
#   ghcr.io/hadron-memory/hadron-server:latest \
#   -c "npx prisma migrate deploy"

ssh alpha 'docker exec hadron-server doppler run -- sh -c "npx prisma db push --force-reset && npx tsx prisma/seed.ts"'
