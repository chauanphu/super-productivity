#!/bin/sh
# Daily pg_dump of the planner database; keeps 14 days. Restore:
#   gunzip -c backups/planner-YYYY-MM-DD.sql.gz | docker exec -i planner-db psql -U planner planner
set -eu
cd "$(dirname "$0")"
OUT="backups/planner-$(date +%F).sql.gz"
docker exec planner-db pg_dump -U planner --clean --if-exists planner | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
find backups -name "planner-*.sql.gz" -mtime +14 -delete
