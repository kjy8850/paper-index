#!/usr/bin/env bash
# =====================================================================
# DEPRECATED: 이 스크립트는 scripts/sync-to-nas.sh 로 통합되었습니다.
# 하위 호환을 위해 래퍼로 남겨둡니다. 새 코드는 sync-to-nas.sh 를 직접
# 호출하거나 `make nas-sync` 를 사용하세요.
# =====================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[i] scripts/nas-sync.sh 는 deprecated. scripts/sync-to-nas.sh 로 위임합니다."
exec "$HERE/sync-to-nas.sh" "$@"
