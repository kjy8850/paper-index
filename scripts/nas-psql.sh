#!/usr/bin/env bash
# =====================================================================
# 미니PC 에서 NAS Postgres 로 바로 psql 접속.
#
# 사용법:
#   ./scripts/nas-psql.sh [sql]
#
# 예:
#   ./scripts/nas-psql.sh
#   ./scripts/nas-psql.sh "SELECT COUNT(*) FROM research_papers;"
# =====================================================================

set -euo pipefail

# .env 에서 PG* 읽기
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

: "${PGHOST:?PGHOST 미설정}"
: "${PGUSER:?PGUSER 미설정}"
: "${PGDATABASE:?PGDATABASE 미설정}"
: "${PGPASSWORD:?PGPASSWORD 미설정}"

# docker 로 psql 을 일회성 실행 (로컬에 psql 설치 없어도 OK)
if [[ $# -gt 0 ]]; then
  docker run --rm -i \
    -e PGPASSWORD \
    postgres:16-alpine \
    psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" -c "$*"
else
  docker run --rm -it \
    -e PGPASSWORD \
    postgres:16-alpine \
    psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}"
fi
