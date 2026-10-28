#!/usr/bin/env bash
# Local PostgreSQL helper for development and CI (no Docker required).
# Usage: scripts/dev-db.sh start|stop|status|reset
# Creates a throwaway cluster in $PGDATA (default: ./.pgdata) listening on $PGPORT (default 54329).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
export PGDATA="${PGDATA:-$ROOT/.pgdata}"
PGPORT="${PGPORT:-54329}"
RUN=""
if [ "$(id -u)" = "0" ]; then
  # postgres refuses to run as root; use the system postgres user
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA"
  chmod 755 "$ROOT" || true
  RUN="su postgres -c"
fi
run() { if [ -n "$RUN" ]; then $RUN "$*"; else bash -c "$*"; fi; }

case "${1:-start}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      run "$PGBIN/initdb -D '$PGDATA' -A trust -E UTF8 --locale=C.UTF-8 >/dev/null"
    fi
    if ! run "$PGBIN/pg_ctl -D '$PGDATA' status" >/dev/null 2>&1; then
      run "$PGBIN/pg_ctl -D '$PGDATA' -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=200' -l '$PGDATA/server.log' -w start" >/dev/null
    fi
    echo "postgres up on 127.0.0.1:$PGPORT"
    ;;
  stop)   run "$PGBIN/pg_ctl -D '$PGDATA' -m fast stop" || true ;;
  status) run "$PGBIN/pg_ctl -D '$PGDATA' status" ;;
  reset)
    "$0" stop || true
    rm -rf "$PGDATA"
    "$0" start
    ;;
esac
