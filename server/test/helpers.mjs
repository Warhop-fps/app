/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 시험 도우미. 빈 포트에 조용한 서버를 띄우고, 소켓 없이 방을 직접 돌리며 보낸 메시지를 모으고, 이벤트를 꺼내고, 겨누는 함수를 모은다.
 */
import { createRoom } from '../src/room.mjs';
import { startServer } from '../src/server.mjs';
import { createLogger } from '../src/log.mjs';
import { KEY, PRESS } from '../src/protocol.mjs';
import { aimAt } from '../tools/fake-client.mjs';

export { KEY, PRESS, aimAt };

/** 짧은 경기: 2선승(최대 3판), 무기 선택 0.3초, 결과 0.3초 */
export const FAST_RULES = Object.freeze({ roundsToWin: 2, maxRounds: 3, loadoutMs: 300, roundEndMs: 300, roundTimeMs: 20000 });

export const silentLog = () => createLogger({ level: 'silent' });

/** 빈 포트(127.0.0.1)에 서버를 띄운다. 시험의 접속은 모두 같은 IP라 IP당 제한은 그 제한을 보는 시험만 낮춘다 */
export function startTestServer(overrides = {}) {
  return startServer({ port: 0, host: '127.0.0.1', log: silentLog(), matchRules: FAST_RULES, maxPerIp: 64, maxRoomsPerIp: 64, ...overrides });
}

/** 받은 글자를 모으는 가짜 peer */
export function capturePeer() {
  const texts = [];
  return {
    send: (t) => texts.push(t),
    rtt: () => 12,
    texts,
    /** 받은 이벤트 전부(순서대로) */
    events: () => texts.filter((t) => t.startsWith('{"t":"e"')).flatMap((t) => JSON.parse(t).e),
    snapshots: () => texts.filter((t) => t.startsWith('{"t":"s"')).map((t) => JSON.parse(t)),
    last: (type) => { for (let i = texts.length - 1; i >= 0; i--) { const m = JSON.parse(texts[i]); if (m.t === type) return m; } return null; },
    clear: () => { texts.length = 0; }
  };
}

/**
 * 소켓 없이 방 하나와 사람들을 만든다.
 * @param {object} roomOpts createRoom 옵션
 * @param {Array<{name?:string, team?:string}>} people
 */
export function roomWith(roomOpts, people) {
  const room = createRoom({ id: 'test', map: 'arena', rng: seeded(7), ...roomOpts });
  const peers = [];
  const ids = [];
  for (const p of people) {
    const peer = capturePeer();
    const r = room.join({ name: p.name || 'p', team: p.team ?? null, peer });
    if (!r.ok) throw new Error(`join failed: ${r.code}`);
    peers.push(peer);
    ids.push(r.id);
  }
  const seqs = new Map();
  return {
    room,
    peers,
    ids,
    actor: (i) => room.actor(ids[i]),
    /** 사람 i의 입력 하나(번호는 자동) */
    input(i, inp = {}) {
      const s = (seqs.get(i) ?? -1) + 1;
      seqs.set(i, s);
      const a = room.actor(ids[i]);
      room.handle(ids[i], { t: 'in', s, k: 0, y: a.state.yaw, p: a.state.pitch, w: 0, b: 0, vt: null, ...inp });
      return s;
    },
    steps(n) { for (let i = 0; i < n; i++) room.step(); }
  };
}

/** 같은 시드면 같은 수열(mulberry32) */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 사람 a의 눈에서 b의 가슴(서 있으면 발 + 1.25 m)을 보는 yaw·pitch */
export function aimFromTo(a, pos) {
  const eye = a.eye();
  return aimAt(eye, [pos[0], pos[1] + 1.25, pos[2]]);
}

/** 조건이 될 때까지 기다린다(실제 시간) */
export async function until(pred, timeoutMs = 5000, label = 'condition') {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`${label} 시간 초과(${timeoutMs} ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
