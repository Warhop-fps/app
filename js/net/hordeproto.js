/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버의 좀비 방(server/core/horde-room.js)과 손님이 함께 쓰는 메시지 약속. 손님이 보내는 형식 이름, 꼭 닿아야 하는 이벤트 목록과 다시 싣는 시간,
 *          이벤트 번호(eid)로 겹친 이벤트를 거르는 거름망, 손님 메시지 만들기를 한곳에 둔다. 순수 모듈이라 node 시험·가짜 클라이언트도 쓴다(docs/HORDE_SERVER.md 8절).
 */
/**
 * 서버 → 손님
 *   welcome { t:'welcome', v, playerId, team:'owner', room, hz, tick, map, mode:'zombie', leader, zombie:{ snapHz, maxPlayers, ttlMs } }
 *   zlobby  { t:'zlobby', tick, phase, leader, players:[{ id, name }] }      시작 전(대기실)과 판이 끝난 뒤, 명단이 바뀔 때
 *   zsnap   { t:'zsnap', tick, s, ev }     10 Hz. s = director snapshot()(applyHordeSnapshot으로 푼다), ev = 최근 3초의 꼭 닿아야 하는 이벤트(다시 싣기)
 *   zev     { t:'zev', tick, events }      이벤트가 생긴 틱에 바로. 모두에게 가는 이벤트에는 eid(방마다 1부터 늘어나는 번호)가 붙는다
 *                                          거절(type:'reject')은 보낸 사람에게만 가고 eid가 없다
 * 손님은 zev.events와 zsnap.ev를 createEventFilter()로 eid를 보고 한 번씩만 처리한다.
 *
 * 손님 → 서버(join·start는 공통 형식. join.opts.mode = 'zombie')
 *   zs     { t:'zs', x, y, z, yaw, slot, air, alive }          내 발 위치·바라보는 방향·든 슬롯·점프 중(10~30 Hz)
 *   zhit   { t:'zhit', victimId:'z12', weaponId, part, dist, kind, count, shotId }   총·칼 맞힘 주장(director.claimHit)
 *   zswing { t:'zswing', weaponId, kind, shotId }               검기 휘두르기(director.claimSwordSwing)
 *   zboom  { t:'zboom', c:[x,y,z], v:[[좀비 번호, 피해], ...], k? }   폭발 피해(director.claimExplosion). 512바이트 안에 들게 줄여 싣는다
 *   zcard  { t:'zcard', act:'pick'|'reroll', card? }            증강 고르기·다시 뽑기
 *   zloot  { t:'zloot', id }                                    바닥 보급품 줍기
 *   zrev   { t:'zrev', id, on }                                 쓰러진 동료 살리기(누르는 동안 on 1을 0.3초마다, 떼면 0)
 */

/** 방을 만들 때 join.opts.mode에 싣는 값 */
export const HORDE_MODE = 'zombie';

/** 손님이 보낼 수 있는 좀비 형식 */
export const HORDE_CLIENT_TYPES = Object.freeze(['zs', 'zhit', 'zswing', 'zboom', 'zcard', 'zloot', 'zrev']);

/** 스냅샷 주기(Hz). 브라우저 방장과 같다 */
export const HORDE_SNAP_HZ = 10;

/** 꼭 닿아야 하는 이벤트를 스냅샷에 다시 싣는 시간(ms). 지금 세션(sync matchEventTtlMs)과 같다 */
export const HORDE_EVENT_TTL_MS = 3000;

/** 폭발 한 번에 싣는 좀비 수 상한 */
export const HORDE_BOOM_MAX = 40;

/**
 * 놓치면 화면이 어긋나는 이벤트: 단계·스테이지, 출격, 증강 제안·고르기, 레벨업, 보스, 쓰러짐·살림, 보급품 줍기, 들어옴·나감, 끝.
 * 나머지(치명타·밀려남·느려짐 같은 연출)는 한 번만 보낸다. WebSocket은 순서와 도착을 지키므로 끊기지 않으면 한 번으로 닿는다.
 */
export const HORDE_RELIABLE = Object.freeze([
  'phase', 'spawn', 'offer', 'card', 'reroll', 'levelUp', 'boss', 'bossSpawn', 'bossDown', 'clear', 'timeup',
  'down', 'revive', 'loot', 'join', 'leave', 'over'
]);
const RELIABLE = new Set(HORDE_RELIABLE);
export const isReliableEvent = (e) => !!e && RELIABLE.has(e.type);

/**
 * 겹친 이벤트 거름망. accept(e)가 true면 처음 본 이벤트다. eid가 없는 이벤트(거절)는 늘 받는다.
 * 최근 keep개의 번호를 기억한다(3초 다시 싣기에 넉넉하다).
 */
export function createEventFilter(keep = 1024) {
  const set = new Set();
  const order = [];
  return function accept(e) {
    if (!e || typeof e !== 'object') return false;
    if (!Number.isInteger(e.eid)) return true;
    if (set.has(e.eid)) return false;
    set.add(e.eid);
    order.push(e.eid);
    if (order.length > keep) set.delete(order.shift());
    return true;
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

/** 손님 메시지 만들기(가짜 클라이언트·나중에 브라우저가 쓴다). 봇·시뮬레이션의 행동 { t:'hit'|... } → 보낼 객체 */
export function encodeHordeAction(a) {
  if (!a || typeof a !== 'object') return null;
  switch (a.t) {
    case 'hit': return { t: 'zhit', victimId: a.victimId, weaponId: a.weaponId, part: a.part, dist: a.dist, kind: a.kind, count: a.count, shotId: a.shotId };
    case 'swing': return { t: 'zswing', weaponId: a.weaponId, kind: a.kind, shotId: a.shotId };
    case 'explode': {
      const c = a.center || {};
      const at = Array.isArray(c) ? c : [c.x, c.y, c.z];
      const v = [];
      for (const x of Array.isArray(a.victims) ? a.victims : []) {
        const n = Number(String(x && x.id).slice(1));
        if (Number.isInteger(n) && n > 0 && v.length < HORDE_BOOM_MAX) v.push([n, Math.round(Number(x.dmg) || 0)]);
      }
      return { t: 'zboom', c: at.map((q) => r2(Number(q) || 0)), v, ...(a.kind ? { k: a.kind } : {}) };
    }
    case 'pick': return { t: 'zcard', act: 'pick', card: a.cardId };
    case 'reroll': return { t: 'zcard', act: 'reroll' };
    case 'loot': return { t: 'zloot', id: a.lootId };
    case 'revive': return { t: 'zrev', id: a.targetId, on: a.on === false ? 0 : 1 };
    default: return null;
  }
}

/** 내 상태 → zs */
export function encodeHordeState(s) {
  if (!s || s.alive === false || !Number.isFinite(s.x) || !Number.isFinite(s.z)) return { t: 'zs', alive: false };
  return {
    t: 'zs', x: r2(s.x), y: r2(Number(s.y) || 0), z: r2(s.z), yaw: Number.isFinite(s.yaw) ? Math.round(s.yaw * 1000) / 1000 : null,
    slot: Number.isInteger(s.slot) ? s.slot : null, air: s.air === true, alive: true
  };
}
