/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 소켓 시험 도우미. 빈 포트에 조용한 서버(Node 어댑터)를 띄우고, 조건이 될 때까지 기다린다. 방 로직만 보는 도우미는 tests/server-room-kit.mjs에 있다.
 */
import { startServer } from '../node/server.js';
import { createLogger } from '../node/log.js';
import { FAST_RULES } from '../../tests/server-room-kit.mjs';

export { FAST_RULES };

export const silentLog = () => createLogger({ level: 'silent' });

/** 빈 포트(127.0.0.1)에 서버를 띄운다. 시험의 접속은 모두 같은 IP라 IP당 제한은 그 제한을 보는 시험만 낮춘다 */
export function startTestServer(overrides = {}) {
  return startServer({ port: 0, host: '127.0.0.1', log: silentLog(), matchRules: FAST_RULES, maxPerIp: 64, maxRoomsPerIp: 64, ...overrides });
}

/** 조건이 될 때까지 기다린다(실제 시간) */
export async function until(pred, timeoutMs = 5000, label = 'condition') {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`${label} 시간 초과(${timeoutMs} ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
