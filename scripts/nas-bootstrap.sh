#!/usr/bin/env bash
# =====================================================================
# NAS (Synology DS918+) 최초 부트스트랩 스크립트
# 미니PC 에서 1회 실행 → SSH 로 NAS 에 폴더 만들고 필수 파일 전송.
#
# 사전 조건:
#  - NAS 에 SSH 활성화 (DSM → 제어판 → 터미널 및 SNMP).
#  - 미니PC 에서 `ssh $NAS_SSH_HOST` 가 키 인증으로 접속 가능.
#  - DSM 관리자 계정에 sudo 권한.
#
# 환경변수:
#   NAS_SSH_HOST (default: nas-papers)     ~/.ssh/config Host 엔트리
#   NAS_BASE     (default: /volume1/docker/papers-pg)
#   ENV_NAS_SRC  (default: .env.nas)       미니PC 에서 읽을 NAS용 .env
# =====================================================================

set -euo pipefail

NAS_SSH_HOST=${NAS_SSH_HOST:-nas-papers}
NAS_BASE=${NAS_BASE:-/volume1/docker/papers-pg}
ENV_NAS_SRC=${ENV_NAS_SRC:-.env.nas}

RED='\033[1;31m'; GRN='\033[1;32m'; BLU='\033[1;34m'; OFF='\033[0m'
say()  { printf "${BLU}▶${OFF} %s\n" "$*"; }
ok()   { printf "${GRN}✓${OFF} %s\n" "$*"; }
die()  { printf "${RED}✗${OFF} %s\n" "$*" >&2; exit 1; }

# -- 사전 확인 ----------------------------------------------------------
[[ -f docker-compose.nas.yml ]] || die "docker-compose.nas.yml 이 현재 폴더에 없습니다. 레포 루트에서 실행하세요."
[[ -f sql/init.sql          ]] || die "sql/init.sql 이 없습니다."
[[ -f $ENV_NAS_SRC          ]] || die "$ENV_NAS_SRC 이 없습니다. .env.nas.example 을 복사해 값을 채워주세요."

say "SSH 접속 확인 중: $NAS_SSH_HOST"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$NAS_SSH_HOST" "echo ok" >/dev/null \
  || die "SSH 접속 실패. ~/.ssh/config 의 Host $NAS_SSH_HOST 와 SSH 키 설정을 확인하세요."
ok  "SSH 접속 OK"

say "NAS 폴더 준비: $NAS_BASE"
ssh "$NAS_SSH_HOST" "sudo mkdir -p '$NAS_BASE/sql' '$NAS_BASE/data' && sudo chown -R \$USER:users '$NAS_BASE'"
ok  "폴더 생성/권한 OK"

say "파일 전송 (docker-compose.nas.yml → docker-compose.yml, sql/, .env)"
# sync-to-nas.sh 와 동일한 규약: NAS 위에서는 docker-compose.yml 로 저장 (compose 기본 파일명).
rsync -avz docker-compose.nas.yml "$NAS_SSH_HOST:$NAS_BASE/docker-compose.yml"
rsync -avz --delete sql/          "$NAS_SSH_HOST:$NAS_BASE/sql/"
rsync -avz "$ENV_NAS_SRC"         "$NAS_SSH_HOST:$NAS_BASE/.env"
ssh "$NAS_SSH_HOST" "chmod 600 $NAS_BASE/.env"
ok  "전송 완료"

say "pgvector 이미지 pull (시간 다소 소요)"
ssh "$NAS_SSH_HOST" "sudo docker pull pgvector/pgvector:pg16"
ok  "이미지 pull 완료"

say "컨테이너 최초 기동"
ssh "$NAS_SSH_HOST" "cd $NAS_BASE && sudo docker compose up -d"
ok  "컨테이너 기동 명령 전송"

sleep 5
say "헬스체크 (최대 30초 대기)"
for i in {1..15}; do
  if ssh "$NAS_SSH_HOST" "sudo docker exec paper-postgres pg_isready -U paperuser -d papers" 2>/dev/null | grep -q accepting; then
    ok "Postgres 기동 완료"
    break
  fi
  sleep 2
  [[ $i -eq 15 ]] && die "Postgres 기동 실패. ssh $NAS_SSH_HOST 'sudo docker logs paper-postgres' 확인."
done

say "스키마 검증"
ssh "$NAS_SSH_HOST" "sudo docker exec paper-postgres psql -U paperuser -d papers -c '\dt'"
ok  "부트스트랩 완료 🎉"

cat <<'EOF'

다음 단계 (미니PC 에서):
  1) .env (미니PC용) 의 PGHOST 를 NAS LAN IP 로 맞추세요.
  2) make up
  3) make test-gemini
  4) make collect-once Q="EUV photoresist" N=5
EOF
