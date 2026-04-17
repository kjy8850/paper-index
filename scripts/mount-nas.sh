#!/usr/bin/env bash
# =====================================================================
# DS918+ NFS 공유폴더 → 미니PC 마운트 헬퍼
#
# 사전 준비 (DSM 에서):
#   1) 제어판 → 파일 서비스 → NFS → "NFSv4 지원" 체크 → 활성화.
#   2) 공유폴더 'docker' 의 하위 'papers-pg' 생성.
#   3) 공유폴더 편집 → NFS 권한 → 생성:
#        - 호스트: 미니PC IP 또는 192.168.1.0/24
#        - 권한: 읽기/쓰기
#        - Squash: "관리자 사용자 불허"
#        - "비동기" 체크
#   4) 저장 후, NFS 규칙 화면에 "/volume1/docker/papers-pg" 경로 확인.
#
# 사용법:
#   ./scripts/mount-nas.sh <NAS_IP> <원격경로> [마운트포인트]
# 예:
#   ./scripts/mount-nas.sh 192.168.1.50 /volume1/docker/papers-pg
#   ./scripts/mount-nas.sh 192.168.1.50 /volume1/docker/papers-pg /mnt/nas-papers-pg
#
# fstab 에 영구 등록하려면 --persist 플래그:
#   ./scripts/mount-nas.sh 192.168.1.50 /volume1/docker/papers-pg /mnt/nas-papers-pg --persist
# =====================================================================

set -euo pipefail

NAS_IP="${1:-}"
REMOTE="${2:-}"
MOUNT="${3:-/mnt/nas-papers-pg}"
PERSIST="${4:-}"

if [[ -z "${NAS_IP}" || -z "${REMOTE}" ]]; then
  echo "사용법: $0 <NAS_IP> <원격경로> [마운트포인트] [--persist]"
  echo "예:    $0 192.168.1.50 /volume1/docker/papers-pg /mnt/nas-papers-pg --persist"
  exit 2
fi

# 필수 패키지
command -v mount.nfs >/dev/null 2>&1 || sudo apt-get install -y nfs-common

sudo mkdir -p "${MOUNT}"

# 이미 마운트되어 있는지 확인
if mountpoint -q "${MOUNT}"; then
  echo "[i] ${MOUNT} 가 이미 마운트되어 있습니다."
else
  echo "[+] ${NAS_IP}:${REMOTE} → ${MOUNT}"
  sudo mount -t nfs -o vers=4,soft,timeo=50,retrans=3 \
    "${NAS_IP}:${REMOTE}" "${MOUNT}"
fi

echo "[+] 마운트 상태:"
mount | grep "${MOUNT}" || true
ls -la "${MOUNT}" | head -20 || true

if [[ "${PERSIST}" == "--persist" ]]; then
  LINE="${NAS_IP}:${REMOTE} ${MOUNT} nfs4 _netdev,auto,soft,timeo=50,retrans=3 0 0"
  if grep -qE "^${NAS_IP}:${REMOTE}[[:space:]]" /etc/fstab 2>/dev/null; then
    echo "[i] fstab 에 이미 등록되어 있습니다."
  else
    echo "[+] /etc/fstab 에 등록:"
    echo "    ${LINE}"
    echo "${LINE}" | sudo tee -a /etc/fstab >/dev/null
  fi
fi

cat <<EOF

[다음 단계]
  - 원격 쓰기 테스트:
      touch ${MOUNT}/.write-test && rm ${MOUNT}/.write-test && echo "OK"
  - NAS 쪽 배포 파일 동기화:
      ./scripts/sync-to-nas.sh
EOF
