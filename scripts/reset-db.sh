#!/usr/bin/env bash

DATABASE_URL=postgresql://holger@localhost:5432/hadron npx prisma db push --force-reset
npx tsx prisma/seed.ts

