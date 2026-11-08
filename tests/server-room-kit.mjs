/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 방 로직(server/core)을 소켓 없이 돌리는 시험 도우미. 방과 사람을 만들고, send로 받은 글자를 사람별로 모으고, 이벤트를 꺼내고, 겨누는 함수를 모은다.
 *          ws를 불러오지 않아 서버 의존성 없이 npm test에서 돈다(파일 이름이 .test.mjs가 아니라 시험으로 따로 돌지 않는다).
 */
import { createRoom } from '../server/core/room.js';
import { aimAt } from '../server/core/combat.js';
import { KEY, PRESS } from '../server/core/protocol.js';

export { KEY, PRESS, aimAt };

/** 짧은 경기: 2선승(최대 3판), 무기 선택 0.3초, 결과 0.3초 */
export const FAST_RULES = Object.freeze({ roundsToWin: 2, maxRounds: 3, loadoutMs: 300, roundEndMs: 300, roundTimeMs: 20000 });

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

/** 한 사람이 받은 글자 목록을 읽는 도우미 */
function inboxView(texts) {
  return {
    texts,
    /** 받은 이벤트 전부(순서대로) */
    events: () => texts.filter((t) => t.startsWith('{"t":"events"')).flatMap((t) => JSON.parse(t).events),
    snapshots: () => texts.filter((t) => t.startsWith('{"t":"snap"')).map((t) => JSON.parse(t)),
    clear: () => { texts.length = 0; }
  };
}

/**
 * 소켓 없이 방 하나와 사람들을 만든다. 사람 id는 p1, p2, … (어댑터가 정하는 신원 자리)
 * @param {object} roomOpts createRoom 옵션(send·rttOf는 여기서 채운다)
 * @param {Array<{name?:string, team?:string}>} people
 */
export function roomWith(roomOpts, people) {
  const inbox = new Map();
  const room = createRoom({
    send: (pid, text) => { const box = inbox.get(pid); if (box) box.push(text); },
    rttOf: () => 12,
    id: 'test', map: 'arena', rng: seeded(7), ...roomOpts
  });
  const ids = [];
  const peers = [];
  people.forEach((p, i) => {
    const pid = `p${i + 1}`;
    const box = [];
    inbox.set(pid, box);
    const r = room.join(pid, { name: p.name || 'p', team: p.team ?? null });
    if (!r.ok) throw new Error(`join failed: ${r.code}`);
    ids.push(pid);
    peers.push(inboxView(box));
  });
  const seqs = new Map();
  return {
    room,
    peers,
    ids,
    inbox,
    actor: (i) => room.actor(ids[i]),
    /** 사람 i의 입력 하나(번호는 자동, 시점은 지금 그대로가 기본) */
    input(i, inp = {}) {
      const seq = (seqs.get(i) ?? -1) + 1;
      seqs.set(i, seq);
      const a = room.actor(ids[i]);
      room.input(ids[i], { t: 'input', seq, keys: 0, press: 0, slot: 0, yaw: a.state.yaw, pitch: a.state.pitch, viewTick: null, ...inp });
      return seq;
    },
    steps(n) { for (let i = 0; i < n; i++) room.tick(); }
  };
}

/** 사람 a의 눈에서 pos(발)에 선 사람의 가슴(발 + 1.25 m)을 보는 yaw·pitch */
export function aimFromTo(a, pos) {
  return aimAt(a.eye(), [pos[0], pos[1] + 1.25, pos[2]]);
}
