#!/bin/sh
# Container entrypoint for the planner image: migrate, then start the server.
# prisma/migrations has no initial migration (the first one ALTERs "operations"), so
# `migrate deploy` fails on an empty database. For an empty database we create the schema
# from schema.prisma and mark every existing migration as applied (Prisma baselining);
# later migrations then apply normally. Existing databases go straight to migrate deploy.
set -e

if node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.\$queryRaw\`SELECT to_regclass('public.operations')::text AS t\`
    .then((r) => process.exit(r[0].t ? 1 : 0))
    .catch((e) => { console.error(e); process.exit(2); });
"; then
  echo 'Empty database: creating schema from prisma/schema.prisma and baselining migrations'
  npx prisma db push --skip-generate
  for m in prisma/migrations/*/; do
    npx prisma migrate resolve --applied "$(basename "$m")"
  done
fi

npx prisma migrate deploy
exec node dist/src/index.js
