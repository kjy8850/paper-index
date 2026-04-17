#!/usr/bin/env bash
# =====================================================================
# 미니PC (Ubuntu 24.04 / Debian 12) 초기 셋업 스크립트
# - Docker Engine + Compose plugin
# - Node.js 22 (NodeSource)
# - Claude Code CLI
# - NFS 클라이언트
# - git, rsync, make, tmux, jq
#
# 사용법:
#   chmod +x scripts/bootstrap-minipc.sh
#   ./scripts/bootstrap-minipc.sh
#
# 권장: 완전 fresh 한 Ubuntu 24.04 에서 한 번만 실행.
# =====================================================================

set -euo pipefail

C_GREEN="\033[0;32m"; C_YELLOW="\033[0;33m"; C_RED="\033[0;31m"; C_RESET="\033[0m"
log()  { echo -e "${C_GREEN}[+]${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}[!]${C_RESET} $*"; }
fail() { echo -e "${C_RED}[x]${C_RESET} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && fail "루트로 실행하지 마세요. 일반 사용자로 실행하면 필요한 곳에서 sudo 를 씁니다."

# ---------------------------------------------------------------------
log "0/7 패키지 인덱스 갱신"
sudo apt-get update -y

log "1/7 기본 유틸 설치 (git/rsync/make/tmux/jq/curl/ca-certificates/nfs-common)"
sudo apt-get install -y \
  git rsync make tmux jq curl ca-certificates gnupg lsb-release \
  nfs-common openssh-client

# ---------------------------------------------------------------------
log "2/7 Docker Engine + Compose plugin 설치"
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
    https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  warn "docker 그룹에 추가됨. 이 스크립트 종료 후 반드시 재로그인(또는 'newgrp docker')."
else
  log "  - 이미 설치됨: $(docker --version)"
fi

# ---------------------------------------------------------------------
log "3/7 Node.js 22 (NodeSource) 설치"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | grep -oP '^v\d+' | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  log "  - 이미 설치됨: $(node -v)"
fi
# npm 글로벌 prefix 를 사용자 홈으로 (sudo 없이 global 패키지 설치 가능)
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
if ! grep -q 'npm-global/bin' "$HOME/.bashrc"; then
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
fi
export PATH="$HOME/.npm-global/bin:$PATH"

# ---------------------------------------------------------------------
log "4/7 Claude Code CLI 설치"
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
else
  log "  - 이미 설치됨: $(claude --version 2>/dev/null || echo 'claude')"
fi

# ---------------------------------------------------------------------
log "5/7 프로젝트 의존성 설치 (있으면)"
if [[ -f package.json ]]; then
  npm install --no-audit --no-fund
fi

# ---------------------------------------------------------------------
log "6/7 유용한 systemd 서비스 활성화 확인"
sudo systemctl enable --now docker || true

# ---------------------------------------------------------------------
log "7/7 체크"
{
  echo "--- 버전 정보 ---"
  command -v docker  && docker --version
  command -v docker compose version || true
  docker compose version || true
  command -v node    && node -v
  command -v npm     && npm -v
  command -v claude  && claude --version || echo "claude (설치됨)"
  command -v rsync   && rsync --version | head -1
  command -v mount.nfs && mount.nfs -V 2>&1 | head -1 || true
} || true

cat <<EOF

${C_GREEN}✅ 부트스트랩 완료.${C_RESET}

[다음 단계]
  1) 재로그인 또는 'newgrp docker'  ← docker 그룹 권한 적용
  2) .env 파일 준비:
        cp .env.minipc.example .env   # 값 채우기
  3) NAS NFS 마운트:
        ./scripts/mount-nas.sh <NAS_IP> <공유폴더_경로>
     예) ./scripts/mount-nas.sh 192.168.1.50 /volume1/docker/papers-pg
  4) NAS 쪽 배포:
        ./scripts/sync-to-nas.sh
  5) 미니PC 컨테이너 기동:
        docker compose -f docker-compose.minipc.yml up -d --build

  Claude Code 는 이 프로젝트 디렉터리에서 'claude' 만 치시면 동작합니다.
EOF
