/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버 실행 진입점(npm run server). 설정을 읽어 서버를 띄우고, SIGINT·SIGTERM에 접속을 정리하고 끝낸다. 의존성이 없으면 설치 방법을 알려 준다.
 */
import { loadConfig, USAGE } from './config.mjs';
import { createLogger } from './log.mjs';

let parsed;
try {
  parsed = loadConfig();
} catch (err) {
  console.error(`설정 오류: ${err.message}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.help) {
  console.log(USAGE);
  process.exit(0);
}
const { config } = parsed;
const log = createLogger({ level: config.logLevel, base: { service: 'skala-server' } });

let startServer;
try {
  ({ startServer } = await import('./server.mjs'));
} catch (err) {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND' && /'ws'/.test(String(err.message))) {
    console.error('서버 의존성(ws)이 없습니다. 저장소 루트에서 먼저 실행하세요:\n  npm --prefix server ci');
    process.exit(1);
  }
  throw err;
}

process.on('uncaughtException', (err) => {
  // 상태를 믿을 수 없으니 기록하고 끝낸다. systemd(Restart=on-failure)가 다시 띄운다
  log.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'unhandled rejection');
  process.exit(1);
});

let server;
try {
  server = await startServer({ ...config, log });
} catch (err) {
  log.fatal({ err, port: config.port, host: config.host }, 'failed to start');
  process.exit(1);
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
