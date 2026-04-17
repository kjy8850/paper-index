# ⏱ 30분 런북 — 미니PC(Ubuntu 24.04) + DS918+ (NFS + SSH)

처음부터 끝까지 "내가 뭘 해야 하는지"만 순서대로. 각 단계 뒤의 **✔ 검증** 블록으로 다음 단계 넘어가도 되는지 바로 확인하세요.

> 전제: 미니PC·NAS 모두 같은 공유기에 있고 고정 IP 할당됨. 예시는 `nas=192.168.1.50`, `minipc=192.168.1.60`.

---

## 0. 준비물 체크 (2분)

- [ ] Gemini API 키 — https://aistudio.google.com/apikey
- [ ] NAS 관리자 계정 비밀번호
- [ ] 긴 랜덤 비밀번호 생성: `openssl rand -base64 24` 로 **3개**
  - `PGPASSWORD` (Postgres)
  - `INGEST_API_KEY` (n8n → ingest 인증)
  - `N8N_PASSWORD` (n8n 웹 UI 로그인)

---

## 1. NAS (DS918+) 쪽 기초 설정 (7분)

### 1-1. SSH 활성화
`DSM → 제어판 → 터미널 및 SNMP → SSH 서비스 활성화`. 포트 기본 22.

### 1-2. NFS 활성화
`DSM → 제어판 → 파일 서비스 → NFS → NFS 서비스 활성화`.

### 1-3. 공유폴더 만들기
`DSM → File Station → 만들기 → 공유폴더`:
- 이름: `docker`
- 경로: `/volume1/docker` (자동)

그 아래 `papers-pg/data`, `papers-pg/sql` 폴더는 부트스트랩 스크립트가 자동으로 만들어줍니다.

### 1-4. NFS 권한 편집
`제어판 → 공유폴더 → docker 선택 → 편집 → NFS 권한 → 만들기`:
- 호스트/IP : `192.168.1.60` (미니PC IP만 허용)
- 권한: **읽기/쓰기**
- Squash: **매핑 안 함 (모든 사용자가 관리자로 매핑)**
- 보안: **sys**
- 비동기 활성화 ✅
- 비특권 포트에서 연결 허용 ✅

저장하면 실제 NFS 경로가 `nas-papers:/volume1/docker` 형태로 뜹니다.

### 1-5. 방화벽 룰
`DSM → 제어판 → 보안 → 방화벽 → 프로파일 편집 → 규칙 편집`:
- `5432`, `2049`, `22` 는 **소스 IP = 192.168.1.0/24** 만 허용.
- 외부(인터넷) 접근 모두 거부.

### ✔ 검증 (미니PC 에서)
```bash
ssh admin@192.168.1.50 "echo ok"            # 비밀번호 물으면 OK
showmount -e 192.168.1.50                    # Export list 에 /volume1/docker 보여야 함
nc -zv 192.168.1.50 5432                     # 아직 거부되어야 정상 (DB 미기동)
```

---

## 2. 미니PC (Ubuntu 24.04) 기초 세팅 (8분)

### 2-1. 필수 패키지
```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg rsync nfs-common git make jq postgresql-client
```

### 2-2. Docker Engine
```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker
docker run --rm hello-world
```

### 2-3. Node.js 22
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

### 2-4. SSH 키 등록 (NAS)
```bash
ssh-keygen -t ed25519 -C "minipc-to-nas"          # 이미 있으면 생략
ssh-copy-id admin@192.168.1.50                    # NAS 비밀번호 입력

# ~/.ssh/config 엔트리
cat >> ~/.ssh/config <<'EOF'

Host nas-papers
  HostName 192.168.1.50
  User admin
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
EOF
chmod 600 ~/.ssh/config

# 검증
ssh nas-papers "whoami"    # admin
```

### 2-5. NFS 마운트
```bash
sudo mkdir -p /mnt/nas-papers-pg

# 임시 마운트로 확인
sudo mount -t nfs 192.168.1.50:/volume1/docker/papers-pg /mnt/nas-papers-pg
ls /mnt/nas-papers-pg       # 빈 폴더 정상

# 영구 마운트 (/etc/fstab)
echo '192.168.1.50:/volume1/docker/papers-pg  /mnt/nas-papers-pg  nfs  defaults,_netdev,nofail,x-systemd.automount  0 0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a
mount | grep nas-papers-pg  # 마운트 상태 확인
```

### ✔ 검증
```bash
touch /mnt/nas-papers-pg/hello.txt && ls /mnt/nas-papers-pg/
ssh nas-papers "ls /volume1/docker/papers-pg/"     # hello.txt 가 NAS 에도 보여야 함
rm /mnt/nas-papers-pg/hello.txt
```

---

## 3. 레포 복제 + .env 세팅 (3분)

```bash
# 원하는 경로에 (예: ~/projects)
cd ~/projects
git clone <내-레포-주소> paper-index
cd paper-index

# 의존성
make install

# 두 개의 .env 생성
cp .env.nas.example     .env.nas
cp .env.minipc.example  .env

# .env.nas 편집: PGPASSWORD=<긴랜덤>, PG_BIND_IP=192.168.1.50
# .env        편집: GEMINI_API_KEY, PGHOST=192.168.1.50, PGPASSWORD=<위와 동일>,
#                   INGEST_API_KEY, N8N_USER/PASSWORD
nano .env.nas
nano .env
```

> 💡 `.env` 의 `PGPASSWORD` 와 `.env.nas` 의 `PGPASSWORD` 는 **반드시 같아야** 합니다. NAS 가 이 값으로 계정 만들고 미니PC 가 이 값으로 접속합니다.

---

## 4. NAS 부트스트랩 (3분)

```bash
make nas-check      # NFS, SSH 둘 다 OK 인지 확인
make nas-bootstrap  # 폴더 생성 + 파일 전송 + pgvector 이미지 pull + compose up
```

스크립트가 끝날 때 `Postgres 기동 완료` 와 테이블 리스트가 보이면 성공.

### ✔ 검증
```bash
make nas-ps          # paper-postgres 가 running
make nas-psql        # NAS Postgres 에 psql 접속 — \dt 로 테이블 보이면 OK (\q 로 나옴)
```

---

## 5. 미니PC 스택 기동 (4분)

```bash
make up              # ingest + n8n 빌드 & 기동
make health          # {"ok":true, ...}
make logs            # 에러 없는지 2~3초 관찰 → Ctrl+C
```

### 5-1. Gemini 연결 테스트
```bash
make test-gemini
# JSON 분석 + 768 차원 임베딩이 나오면 성공
```

### 5-2. 소량 수집
```bash
make collect-once Q="EUV photoresist resin" N=5
make recent          # 방금 들어간 5 건이 보여야 함
```

---

## 6. n8n 워크플로 연결 (3분)

1. 브라우저: `http://192.168.1.60:5678` → Basic Auth 로그인 (`.env` 의 `N8N_USER/PASSWORD`).
2. 우측 상단 **⋮ → Import from File** → `n8n/workflow.json` 선택.
3. 임포트된 워크플로 → **Ingest API 호출** 노드 → URL 을 `http://ingest:8787/ingest/batch` 로 확인 (기본값 그대로).
4. **Execute Workflow** (▶) → 수동 실행 → 결과가 배치별로 쌓이면 OK.
5. 좌상단 **Active** 토글을 ON. 다음 06:00 부터 자동.

---

## 7. Claude Desktop 연결 (2분, 메인 컴퓨터에서)

> 이 단계는 미니PC 가 아니라 Claude Desktop 을 깐 메인 컴퓨터(맥/윈도우)에서 진행합니다.

`~/Library/Application Support/Claude/claude_desktop_config.json` 또는 `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "paper-index": {
      "command": "node",
      "args": ["/절대경로/paper-index/src/mcp-server.js"],
      "env": {
        "GEMINI_API_KEY": "...",
        "PGHOST":     "192.168.1.50",
        "PGPORT":     "5432",
        "PGDATABASE": "papers",
        "PGUSER":     "paperuser",
        "PGPASSWORD": "위_.env_와_동일"
      }
    }
  }
}
```

> ⚠️ 메인 컴퓨터에도 **이 레포가 clone 되어 있고 `npm install` 이 끝나 있어야** 합니다. Claude Desktop 이 직접 `node src/mcp-server.js` 를 실행하기 때문.

### ✔ 검증
Claude Desktop 재시작 → 입력창 옆 플러그 아이콘에 `paper-index` 가 뜨면 성공. 프롬프트 예:

> “내 논문 DB 에서 메탈옥사이드 레지스트의 LER 2nm 미만 달성한 최근 논문 3개 요약해줘.”

---

## 8. 자주 쓰는 명령 치트시트

```bash
make help            # 타깃 목록
make up              # 미니PC 기동
make down            # 미니PC 정지
make logs            # 전체 로그
make logs-ingest     # ingest 만

make nas-sync        # 설정 파일 NAS 에 반영 (NFS 우선)
make nas-up          # NAS Postgres 기동
make nas-down        # NAS Postgres 정지
make nas-psql        # NAS Postgres 에 psql 세션

make test-gemini     # Gemini 동작 확인
make test-search Q="질문"
make collect-once Q="쿼리" N=10

make stats           # 최근 수집 통계
make errors          # 실패 사유 10건
make recent          # 24h 수집분
```

---

## 9. 장애 대응 요약

| 증상 | 즉시 확인할 것 |
|---|---|
| `make up` 이 ingest 에서 `ECONNREFUSED` | NAS Postgres 미기동 → `make nas-up`. 또는 `.env` 의 PGHOST/PGPASSWORD 불일치 |
| NFS 마운트가 사라짐 | `sudo mount -a`. fstab 의 `x-systemd.automount` 가 빠졌는지 확인 |
| `make nas-bootstrap` 중 `permission denied` | NAS 폴더 소유자 문제. `ssh nas-papers "sudo chown -R \$USER:users /volume1/docker/papers-pg"` |
| Gemini 429 반복 | `.env` 에서 `GEMINI_CONCURRENCY=2`, `GEMINI_MIN_INTERVAL_MS=800`. n8n Wait 노드 5→15s |
| Claude Desktop 에 MCP 안 뜸 | config JSON 유효성 검증, Claude 완전 종료 후 재시작, node 경로가 PATH 에 있는지 |
| NAS CPU 100% | 레포의 `docker-compose.nas.yml` 의 `shared_buffers`, `work_mem` 절반으로 → `make nas-sync` → `make nas-restart` (NAS 위에서는 `docker-compose.yml` 로 저장됨) |

---

## 10. 완료 후 유지보수 주기

- **매일**: n8n Executions 탭 훑어보기 (실패 없나).
- **주간**: `make stats && make errors` 로 경향 체크.
- **월간**: `make nas-reindex` (벡터 인덱스 품질 유지), Gemini 사용량 확인.
- **분기**: Hyper Backup 으로 `/volume1/docker/papers-pg/data` 외장 백업.

끝.
