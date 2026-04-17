#!/usr/bin/env bash
# =====================================================================
# NAS 에 필요한 최소 파일만 rsync 로 동기화.
# (NAS 는 Postgres 만 돌리므로 Node 코드·node_modules 등은 보내지 않음)
#
# 보내는 파일:
#   - docker-compose.nas.yml  →  docker-compose.yml (NAS 쪽에서 기본 이름 사용)
#   - sql/init.sql
#   - .env.nas               →  .env (NAS 쪽)
#
# 기본 마운트 포인트: /mnt/nas-papers-pg
#   다른 경로면:  NAS_MOUNT=/your/path ./scripts/sync-to-nas.sh
#
# DRY-RUN:  DRY_RUN=1 ./scripts/sync-to-nas.sh
# =====================================================================

set -euo pipefail

NAS_MOUNT="${NAS_MOUNT:-/mnt/nas-papers-pg}"
DRY_RUN="${DRY_RUN:-0}"

C_G="\033[0;32m"; C_Y="\033[0;33m"; C_R="\033[0;31m"; C_0="\033[0m"
log()  { echo -e "${C_G}[+]${C_0} $*"; }
warn() { echo -e "${C_Y}[!]${C_0} $*"; }
fail() { echo -e "${C_R}[x]${C_0} $*" >&2; exit 1; }

# 사전 체크
[[ -d "${NAS_MOUNT}" ]] || fail "${NAS_MOUNT} 가 존재하지 않습니다. 먼저 ./scripts/mount-nas.sh 실행."
mountpoint -q "${NAS_MOUNT}" || fail "${NAS_MOUNT} 가 마운트되어 있지 않습니다."

[[ -f docker-compose.nas.yml ]] || fail "docker-compose.nas.yml 없음. 프로젝트 루트에서 실행하세요."
[[ -f sql/init.sql          ]] || fail "sql/init.sql 없음."

# .env.nas 준비 체크 (있으면 .env 로 복사, 없으면 경고)
ENV_SRC=""
if [[ -f .env.nas ]]; then ENV_SRC=".env.nas"
elif [[ -f .env.nas.example ]]; then
  warn ".env.nas 가 없습니다. .env.nas.example 이 전송되지만 NAS 에서 반드시 값 채워야 합니다."
  ENV_SRC=".env.nas.example"
fi

RSYNC_FLAGS=(-av --delete --mkpath)
[[ "${DRY_RUN}" == "1" ]] && RSYNC_FLAGS+=(--dry-run)

log "대상: ${NAS_MOUNT}"
log "파일 1/3: docker-compose.nas.yml → docker-compose.yml"
rsync "${RSYNC_FLAGS[@]}" docker-compose.nas.yml "${NAS_MOUNT}/docker-compose.yml"

log "파일 2/3: sql/init.sql"
rsync "${RSYNC_FLAGS[@]}" sql/init.sql "${NAS_MOUNT}/sql/init.sql"

if [[ -n "${ENV_SRC}" ]]; then
  log "파일 3/3: ${ENV_SRC} → .env"
  # .env 가 이미 있으면 덮어쓰지 않도록 안전장치.
  if [[ -f "${NAS_MOUNT}/.env" && "${ENV_SRC}" == ".env.nas.example" ]]; then
    warn "NAS 의 .env 가 이미 있어 덮어쓰지 않습니다. (example 은 .env.nas.example 로만 복사)"
    rsync "${RSYNC_FLAGS[@]}" "${ENV_SRC}" "${NAS_MOUNT}/.env.nas.example"
  else
    rsync "${RSYNC_FLAGS[@]}" "${ENV_SRC}" "${NAS_MOUNT}/.env"
    chmod 600 "${NAS_MOUNT}/.env" 2>/dev/null || true
  fi
fi

# 데이터 디렉터리 확인 (NAS 쪽 Postgres 가 쓸 공간)
if [[ ! -d "${NAS_MOUNT}/data" ]]; then
  log "data/ 디렉터리 생성 (Postgres 데이터 영속 저장용)"
  mkdir -p "${NAS_MOUNT}/data"
fi

log "NAS 쪽 파일 상태:"
ls -la "${NAS_MOUNT}"

cat <<EOF

[다음 단계 — NAS 쪽에서]
  1) Synology Container Manager → 프로젝트 → 생성
     · 경로:          ${NAS_MOUNT}            (= /volume1/docker/papers-pg 등)
     · 원본:          기존 docker-compose.yml
     · 환경 파일:     .env 사용
  2) 빌드 & 실행.
  3) 확인:
       SSH 로 NAS 접속 →
         sudo docker ps | grep paper-postgres
         sudo docker exec -it paper-postgres psql -U paperuser -d papers -c "\\dt"
EOF
