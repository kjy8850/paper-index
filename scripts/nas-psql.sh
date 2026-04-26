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

# psql 직접 실행 (로컬 설치 우선, 없으면 docker --network host)
PSQL_CMD=(psql -h "${PGHOST}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}")
if command -v psql &>/dev/null; then
  if [[ $# -gt 0 ]]; then
    PGPASSWORD="${PGPASSWORD}" "${PSQL_CMD[@]}" -c "$*"
  else
    PGPASSWORD="${PGPASSWORD}" "${PSQL_CMD[@]}"
  fi
else
  if [[ $# -gt 0 ]]; then
    docker run --rm -i --network host \
      -e PGPASSWORD postgres:16-alpine "${PSQL_CMD[@]}" -c "$*"
  else
    docker run --rm -it --network host \
      -e PGPASSWORD postgres:16-alpine "${PSQL_CMD[@]}"
  fi
fi
