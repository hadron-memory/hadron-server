#!/usr/bin/env bash

DATABASE_URL=postgresql://holger@localhost:5432/hadron pnpm prisma db push --force-reset
pnpm run db:seed

