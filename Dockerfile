# =====================================================================
# Node.js 22 기반 ingest/search/mcp 런타임
# 멀티스테이지 빌드로 node_modules 설치 단계와 실행 단계를 분리.
# =====================================================================

# ---- 1) deps 설치 ----
FROM node:22-alpine AS deps
WORKDIR /app
# package manifest 만 먼저 복사 (캐시 활용)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ---- 2) 실행 이미지 ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Alpine 에 없는 tzdata 기본 설치 (TZ 환경변수용)
RUN apk add --no-cache tzdata tini && \
    adduser -D -H -s /sbin/nologin nodeapp

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config/  ./config/
COPY sql/     ./sql/
COPY src/     ./src/
COPY scripts/ ./scripts/

USER nodeapp
EXPOSE 8787
EXPOSE 8788

# tini 로 PID 1 시그널 처리 (SIGTERM 깨끗이 종료)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/ingest.js"]
