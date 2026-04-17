# 🏗 하이브리드 배포 가이드 — DS918+ + N150 미니PC

**구성 요약**

- **NAS (DS918+)** : PostgreSQL 16 + pgvector (DB · 저장소)
- **미니PC (N150)** : n8n + ingest API (+ 선택 MCP HTTP)
- **내 메인 컴퓨터** : Claude Desktop (stdio MCP 서버가 여기서 뜸)

```
Claude Desktop          미니PC (N150)                 NAS (DS918+)
    │   stdio              │                              │
    └── mcp-server.js ─────┼────────┐                     │
                           │ n8n ───┼──▶ ingest API ──▶ PostgreSQL
                           │        │   (port 8787)      (pgvector, 5432)
                           └────────┘
```

---

## 0. 사전 준비

| 항목 | 권장값 |
|---|---|
| DS918+ RAM | **8 GB 증설 필수 권장** (기본 4GB 로는 압박) |
| DSM | 7.2 이상 |
| Container Manager | 설치됨 |
| NAS 고정 IP | 예: `192.168.1.50` (공유기에서 DHCP 예약) |
| 미니PC OS | Ubuntu 24.04 / Debian 12 / Windows + WSL2 중 택일 |
| 미니PC 고정 IP | 예: `192.168.1.60` |

미니PC와 NAS는 **같은 서브넷**(같은 공유기) 안에 있어야 합니다. 두 기기 사이 지연 1ms 미만, 기가비트 LAN이면 DB 원격도 체감 손실 없음.

---

## 1. NAS (DS918+) 쪽 세팅

### 1-1. 공유폴더 준비
1. DSM → **File Station** → `/volume1/docker/papers-pg/data` 폴더 생성.
2. 권한: 관리자만 읽기/쓰기.

### 1-2. 파일 업로드
아래 두 파일을 `/volume1/docker/papers-pg/` 에 올립니다.
- `docker-compose.nas.yml`
- `sql/init.sql` (상위 폴더에 `sql/` 채로)
- `.env` ← `.env.nas.example` 을 복사해 값 채운 것

> 💡 **더 간편한 방법**: 미니PC 에서 NFS 마운트 뒤 `make nas-bootstrap` 한 번이면 파일 전송 + 이미지 pull + 컨테이너 기동까지 자동. 아래 "1-2b. NFS 마운트 기반 자동 부트스트랩" 섹션 참고.

### 1-2b. NFS 마운트 기반 자동 부트스트랩 (권장)

수동 업로드 대신, **미니PC 에서 NAS 를 NFS 로 마운트**하면 Claude Code 가 NAS 파일을 로컬처럼 다룰 수 있어 훨씬 편합니다. RUNBOOK 의 섹션 1~4 를 따라 `make nas-bootstrap` 한 번만 실행하면 됩니다.

NFS 설정 요약 (자세히는 `docs/RUNBOOK.md` 참조):

1. **DSM 쪽**: 제어판 → 파일 서비스 → NFS 활성화, 공유폴더 `docker` 의 NFS 권한에 미니PC IP 만 읽기/쓰기 허용 (squash = "매핑 안 함").
2. **미니PC 쪽**:
   ```bash
   sudo apt install -y nfs-common
   sudo mkdir -p /mnt/nas-papers-pg
   echo '192.168.1.50:/volume1/docker/papers-pg  /mnt/nas-papers-pg  nfs  defaults,_netdev,nofail,x-systemd.automount  0 0' | sudo tee -a /etc/fstab
   sudo mount -a
   ```
3. **검증**: `touch /mnt/nas-papers-pg/ping && ssh nas-papers "ls /volume1/docker/papers-pg/" | grep ping`
4. 이후 `make nas-sync` 는 자동으로 NFS 경로를 감지해 로컬 rsync 수준 속도로 동작. NFS 마운트가 끊겼을 때만 SSH rsync 로 폴백.

방화벽: DSM 의 보안 → 방화벽에서 포트 `2049 / 22 / 5432` 는 `192.168.1.0/24` 서브넷만 허용.

### 1-3. Container Manager 프로젝트 생성
1. **Container Manager → 프로젝트 → 생성**.
2. 경로: `/volume1/docker/papers-pg`
3. 원본: **docker-compose.yml 업로드** → `docker-compose.nas.yml` 선택.
4. 환경변수: `.env` 자동 인식 (없으면 수동 붙여넣기).
5. **빌드 후 실행**.

**확인**
```bash
# NAS 에 SSH
sudo docker ps | grep paper-postgres
sudo docker exec -it paper-postgres psql -U paperuser -d papers -c "\dt"
# research_papers / categories / ingestion_log / search_log 등이 보이면 OK
```

### 1-4. 방화벽 / 보안
- DSM → **제어판 → 보안 → 방화벽** 에서 `5432` 포트를 **내 LAN 서브넷(192.168.1.0/24)만 허용**.
- 외부(인터넷)에서 접근 금지. QuickConnect·DDNS 어느 것도 이 포트 개방 금지.
- `.env.nas` 의 `PGPASSWORD` 는 `openssl rand -base64 24` 수준의 긴 랜덤값.

### 1-5. 백업
Hyper Backup 으로 `/volume1/docker/papers-pg/data` 를 외장 HDD 또는 클라우드에 주 1회 이상 스냅샷.

---

## 2. 미니PC (N150) 쪽 세팅

### 2-1. Docker 설치
Ubuntu 24.04 예시:
```bash
# Docker Engine + Compose v2
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

### 2-2. 프로젝트 복사
```bash
git clone <내-레포> paper-index
# 또는 NAS 공유폴더 → 미니PC rsync
cd paper-index

cp .env.minipc.example .env
nano .env    # GEMINI_API_KEY, PGHOST=NAS IP, PGPASSWORD 등을 채움
```

### 2-3. 컨테이너 기동
```bash
docker compose -f docker-compose.minipc.yml up -d --build
docker compose -f docker-compose.minipc.yml logs -f ingest n8n
```

**헬스체크**
```bash
curl -s http://localhost:8787/health
# {"ok":true,"gemini_model":"gemini-2.5-flash"}

curl -s http://localhost:8787/ingest/batch -X POST \
  -H "x-api-key: $(grep INGEST_API_KEY .env | cut -d= -f2)" \
  -H 'content-type: application/json' \
  -d '{"papers":[]}'
# {"ingested":0,"failed":0,...}
```

### 2-4. n8n 연결
1. 브라우저: `http://<미니PC IP>:5678` → basic auth 로그인.
2. **Import from File** → `n8n/workflow.json`.
3. `Ingest API 호출` 노드의 URL 을 `http://ingest:8787/ingest/batch` 로 수정 (같은 compose 네트워크이므로 서비스명 사용).
4. 저장 → 수동 **Execute Workflow** 한 번 실행 → 정상 동작하면 **Active** 토글.

---

## 3. Claude 연결 (2가지 방법 중 택일)

### 3-A. Claude Desktop (stdio MCP, 권장)
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 또는 `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "paper-index": {
      "command": "node",
      "args": ["/절대경로/paper-index/src/mcp-server.js"],
      "env": {
        "GEMINI_API_KEY": "...",
        "PGHOST": "192.168.1.50",
        "PGPORT": "5432",
        "PGDATABASE": "papers",
        "PGUSER": "paperuser",
        "PGPASSWORD": "..."
      }
    }
  }
}
```

> ⚠️ 이 경우 **프로젝트 폴더를 메인 컴퓨터에도 clone** 해두셔야 합니다. `npm install` 한 번 해야 `node_modules` 가 준비됩니다. Claude Desktop 이 `node src/mcp-server.js` 를 직접 실행하는 구조라서요.

### 3-B. Claude Web (HTTP MCP, 선택)
미니PC에서 MCP HTTP 컨테이너 기동:
```bash
docker compose -f docker-compose.minipc.yml --profile mcp-http up -d mcp-http
```

Claude Web 에서:
1. Settings → Connectors → Add custom connector.
2. URL: `https://<공인_도메인>:8788/mcp` (HTTPS 필수. 미니PC 를 직접 공인망에 노출은 비추천 → Tailscale/Cloudflare Tunnel 권장).
3. Auth: `Authorization: Bearer <MCP_HTTP_TOKEN>`.

> **Cloudflare Tunnel 추천 이유**: 미니PC 포트를 인터넷에 노출하지 않고도 Claude Web 이 접근 가능. `cloudflared tunnel --url http://localhost:8788` 한 줄로 끝.

---

## 4. 일일 운영 체크리스트

| 주기 | 확인 항목 | 방법 |
|---|---|---|
| 매일 | 수집 성공 건수 | `SELECT * FROM v_daily_ingestion ORDER BY day DESC LIMIT 3;` |
| 매일 | n8n 실행 결과 | n8n 웹 UI → Executions |
| 매주 | 실패 사유 | `SELECT error_samples FROM ingestion_log WHERE finished_at > now()-interval '7 days' AND failed>0;` |
| 매주 | 카테고리 분포 | `SELECT major_category, COUNT(*) FROM research_papers GROUP BY 1;` |
| 매주 | DB 스냅샷 | Hyper Backup 상태 |
| 매월 | Gemini 비용 | Google AI Studio 대시보드 |
| 매월 | HNSW 재인덱싱 | `REINDEX INDEX idx_papers_embedding_hnsw;` (선택) |

---

## 5. 트러블슈팅

**`ingest` 컨테이너가 "connection refused" 로 죽음**
→ `PGHOST` 가 NAS 내부 IP 가 맞는지, NAS 방화벽이 5432 를 허용하는지 확인. `docker compose exec ingest ping -c 1 $PGHOST` 로 연결성 체크.

**`n8n` 에서 `http://localhost:8787` 이 안 먹음**
→ 같은 compose 네트워크이므로 **서비스명** `http://ingest:8787` 을 써야 함. `localhost` 는 n8n 컨테이너 자기 자신이 됨.

**DB 에 벡터가 안 들어감 (`invalid input syntax for type vector`)**
→ `pgvector/pgvector:pg16` 이미지가 맞는지 확인. 일반 `postgres:16` 이미지로 실수했을 가능성. Container Manager 에서 이미지명 재확인.

**DS918+ CPU 100% 고정**
→ `shared_buffers`, `work_mem` 을 낮추세요. 기본 `docker-compose.nas.yml` 기준 합계 ~800MB. 4GB RAM 이면 절반으로 축소.

**Gemini 429 지속**
→ `.env.minipc` 에서 `GEMINI_CONCURRENCY=2`, `GEMINI_MIN_INTERVAL_MS=800`. n8n 배치 간 Wait 를 5 → 15 초.

**Claude Desktop 이 MCP 를 인식 못 함**
→ config 파일 JSON 이 유효한지 온라인 검증기에 돌려보고, Claude 완전 종료(트레이에서도 Quit) 후 재시작. `node --version` 이 22 이상인지 확인.

---

## 6. 확장 아이디어

- **미니PC 절전**: 밤에만 켜지도록 WOL + cron 으로 관리. 수집 시간(06:00)만 부팅.
- **PDF 본문 파싱**: ingest 에 `pdf-parse` + Gemini 멀티모달 추가 (`paper.fullText` 지원됨).
- **Tailscale Mesh**: 외부 이동 중에도 NAS DB 에 안전하게 접속. Claude Desktop 설정의 `PGHOST` 를 Tailscale IP 로 교체.
- **주간 리포트**: 토요일 새벽에 top novelty 논문 5건을 이메일/Slack 으로 자동 발송 (n8n 서브워크플로).

---

## 7. 파일 맵 (하이브리드 기준)

```
paper-index/
├─ docker-compose.nas.yml      ◀── DS918+ Container Manager 로 업로드
├─ docker-compose.minipc.yml   ◀── 미니PC 에서 docker compose up
├─ docker-compose.yml          (단일 머신 모드. 하이브리드에선 안 씀)
├─ Dockerfile                  ◀── 미니PC 용 Node 앱 빌드
├─ .dockerignore
├─ .env.nas.example            ◀── NAS 용 env 템플릿
├─ .env.minipc.example         ◀── 미니PC 용 env 템플릿
├─ sql/init.sql                ◀── NAS 에 함께 올리기
├─ src/mcp-server.js           ◀── Claude Desktop 에서 실행 (stdio)
├─ src/mcp-http.js             ◀── Claude Web Custom Connector 용 (선택)
└─ ...
```
