/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 화면 없이 좀비 물량 막기 한 판을 돌리는 방(게임 서버·node 시험용). 맵 데이터로 충돌 월드·길찾기 격자를 만들고,
 *          사람 입력(발 위치·바라보는 방향·든 슬롯·점프 중)과 행동(사격·폭발·카드·보급품·살리기)을 줄 세워 30 Hz 고정 간격마다 시뮬레이션(director.js)에 넣는다.
 *          시계는 틱 수로만 흐르고(벽시계·타이머 없음) 씨앗을 꼭 받으므로, 같은 씨앗·같은 입력이면 같은 이벤트가 나온다.
 *          three.js·DOM·window에 의존하지 않는다. 브라우저 방장(session.js)·혼자 하기(solo.js)는 이 방을 쓰지 않고 director를 바로 부른다(동작은 같다).
 */
/**
 * const room = createHordeRoom({ map: mapData, players: [{ id, name }], seed: 1234 });
 * room.start();                                   // → 이벤트(준비 단계 · 스폰)
 * room.input('p1', { x, y, z, yaw, slot, air, alive });   // 사람마다 최근 상태(다음 틱부터 쓴다)
 * room.send('p1', { t: 'hit', victimId: 'z3', weaponId: 'ar_std', part: 'body', dist: 12, shotId: 7 });
 * const ev = room.step();                         // 30 Hz 한 틱: 줄 선 행동을 받은 순서대로 넣고 → 움직이는 지형 → 시뮬레이션
 * room.snapshot();                                // director 스냅샷(보낼 모양). room.view()는 풀어 둔 모양
 *
 * 행동 t: 'hit'(claimHit) · 'swing'(claimSwordSwing) · 'explode'(claimExplosion) · 'pick'·'reroll'(cardAction) · 'loot'(claimLoot) · 'revive'(reviveAction)
 * 행동은 step()이 부를 때 한꺼번에 들어가므로, 같은 틱 안에서 받은 순서가 곧 판정 순서다.
 */
import { buildCollision, isZombieMap } from '../../../maps/collision.js';
import { buildNavGrid } from '../../navgrid.js';
import { stepMovers } from '../../../engine/movers.js';
import { createHorde, applyHordeSnapshot } from '../director.js';
import { HORDE } from '../rules.js';

/** 좀비 전용 맵이면 좀비 문(레드 쪽 스폰 자리) 목록, 아니면 undefined. session.js·solo.js와 같은 규칙 */
export function zombieGates(data, spawns) {
  return isZombieMap(data) && spawns && Array.isArray(spawns.charterer) ? spawns.charterer : undefined;
}

const ACTIONS = Object.freeze(['hit', 'swing', 'explode', 'pick', 'reroll', 'loot', 'revive']);
const toNum = (v) => (Number.isFinite(+v) ? +v : NaN);

/**
 * @param {object} o
 * @param {object} [o.map]        맵 데이터(js/maps/*.js의 default). 주면 충돌 월드·격자·스폰·좀비 문을 여기서 만든다
 * @param {object} [o.world]      map 대신 직접 줄 때(시험용 빈 시험장은 null)
 * @param {object} [o.nav]
 * @param {object} [o.spawns]
 * @param {Array}  [o.gates]
 * @param {Array<{id,name}>} o.players
 * @param {number} o.seed         꼭 준다(0이 아닌 정수). 같은 씨앗이면 같은 판
 * @param {object} [o.rules]      HORDE 덮어쓰기
 * @param {number} [o.startStage]
 */
export function createHordeRoom(o = {}) {
  const seed = Number(o.seed) >>> 0;
  if (!seed) throw new Error('createHordeRoom: seed가 필요합니다');   // i18n-ok: 개발자용 오류
  let world = o.world || null, nav = o.nav || null, spawns = o.spawns || {}, gates = o.gates;
  if (o.map) {
    const col = buildCollision(o.map);
    world = col.world;
    spawns = col.spawns;
    nav = o.nav !== undefined ? o.nav : buildNavGrid(o.map);
    gates = o.gates !== undefined ? o.gates : zombieGates(o.map, spawns);
  }
  const rules = { ...HORDE, ...(o.rules || {}) };
  const STEP_MS = 1000 / rules.simHz;
  const inputs = new Map();     // id → { x, y, z, yaw, slot, air, alive }
  const queue = [];             // [{ id, a }]
  let ticks = 0;

  /** 살아 있다고 알린 사람의 최근 상태(브라우저 방장의 session positions()와 같은 모양) */
  function positions() {
    const out = {};
    for (const [id, s] of inputs) if (s.alive !== false && Number.isFinite(s.x) && Number.isFinite(s.z)) out[id] = { x: s.x, y: s.y, z: s.z, yaw: s.yaw, slot: s.slot, air: s.air };
    return out;
  }
  const director = createHorde({
    players: o.players || [], world, nav, spawns, gates, seed, rules: o.rules, startStage: o.startStage, getPositions: positions
  });

  /** 사람 상태를 바꾼다(다음 판정부터 쓴다). 모르는 값은 버린다 */
  function input(id, s = {}) {
    const key = String(id);
    const cur = inputs.get(key) || { x: NaN, y: 0, z: NaN, yaw: null, slot: null, air: false, alive: true };
    if (s.x !== undefined) cur.x = toNum(s.x);
    if (s.y !== undefined) cur.y = Number.isFinite(+s.y) ? +s.y : 0;
    if (s.z !== undefined) cur.z = toNum(s.z);
    if (s.yaw !== undefined) cur.yaw = Number.isFinite(+s.yaw) ? +s.yaw : null;
    if (s.slot !== undefined) cur.slot = Number.isFinite(+s.slot) ? +s.slot : null;
    if (s.air !== undefined) cur.air = s.air === true;
    if (s.alive !== undefined) cur.alive = s.alive !== false;
    inputs.set(key, cur);
  }

  /** 행동 하나를 줄 세운다(다음 step에서 판정). 모르는 행동은 false */
  function send(id, a) {
    if (!a || !ACTIONS.includes(a.t)) return false;
    queue.push({ id: String(id), a });
    return true;
  }

  function apply(id, a) {
    switch (a.t) {
      case 'hit': return director.claimHit({ ...a, attackerId: id });
      case 'swing': return director.claimSwordSwing({ ...a, attackerId: id });
      case 'explode': return director.claimExplosion({ ...a, attackerId: id });
      case 'pick': return director.cardAction(id, 'pick', a.cardId);
      case 'reroll': return director.cardAction(id, 'reroll');
      case 'loot': return director.claimLoot(id, a.lootId);
      case 'revive': return director.reviveAction(id, a.targetId, a.on !== false);
      default: return [];
    }
  }

  /** 30 Hz 한 틱. 이벤트를 돌려준다(거절도 by를 붙여 그대로 싣는다: 서버가 보낸 사람에게만 알릴 수 있게) */
  function step() {
    const ev = [];
    const list = queue.splice(0, queue.length);
    for (const { id, a } of list) {
      for (const e of apply(id, a) || []) ev.push(e && e.type === 'reject' ? { ...e, by: id } : e);
    }
    // 움직이는 지형(리프트·문): 브라우저에서는 World가 틱마다 옮기고 director가 같은 충돌 월드를 읽는다. 여기서는 방 시계로 옮긴다
    if (world && world.movers && !world.movers.empty) {
      const bodies = Object.values(positions()).map((p) => [p.x, p.y, p.z]);
      stepMovers(world, (ticks * STEP_MS) / 1000, bodies);
    }
    ev.push(...director.tick(STEP_MS));
    ticks++;
    return ev;
  }

  return {
    start: () => director.start(),
    input, send, step,
    addPlayer: (p) => director.addPlayer(p),
    removePlayer: (id) => { inputs.delete(String(id)); return director.removePlayer(id); },
    snapshot: () => director.snapshot(),
    view: () => applyHordeSnapshot(director.snapshot()),
    dispose: () => director.dispose(),
    get director() { return director; },
    get world() { return world; },
    get nav() { return nav; },
    get spawns() { return spawns; },
    get ticks() { return ticks; },
    get clockMs() { return ticks * STEP_MS; },
    get stepMs() { return STEP_MS; },
    get phase() { return director.phase; },
    get stage() { return director.stage; },
    get seed() { return seed; }
  };
}
