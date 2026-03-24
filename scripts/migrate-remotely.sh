#!/usr/bin/env bash

ssh alpha 'docker exec hadron-server doppler run -- sh -c "npx prisma db push --force-reset && npx tsx prisma/seed.ts"'
