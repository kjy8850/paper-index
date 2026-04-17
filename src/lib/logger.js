// =====================================================================
// 공통 로거. pino + pino-pretty.
// 필요 시 파일 핸들링이나 외부 전송으로 확장.
// =====================================================================

import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: false,
          translateTime: 'yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
});

/**
 * 어떤 컨텍스트에서 호출됐는지 구분하기 위한 child logger 헬퍼.
 */
export function childLogger(bindings) {
  return logger.child(bindings);
}
