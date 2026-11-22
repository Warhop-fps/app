/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 스냅샷의 모양(판 번호·단계 번호·좀비 깃발 비트·보스 번호 기준·좀비 id)과 풀기(applyHordeSnapshot), 결과 요약(hordeSummary).
 *          방장 시뮬레이션(director.js)이 만든 스냅샷을 화면(client.js·view.js)과 게임 서버의 손님이 같은 함수로 푼다. director.js에서 옮겨 왔고 모양은 그대로다.
 *          three.js·DOM에 의존하지 않는다. 스냅샷 줄을 바꾸면 director.js snapshot()과 여기 applyHordeSnapshot을 같이 고치고 HORDE_SNAPSHOT_VERSION을 올린다.
 */
import { zombieByCode, lootByCode } from './rules.js';
import { decodeCards } from './cards.js';
import { bossByCode } from './bosses.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const fromCm = (v) => num(v) / 100;

export const HORDE_SNAPSHOT_VERSION = 2;
/** 단계(스냅샷 zp). 'cards' = 증강을 고르는 동안(좀비·스테이지 시간이 멈춘다). 'break'는 예전 쉬는 시간 자리라 쓰지 않는다 */
export const HORDE_PHASES = Object.freeze(['warmup', 'prep', 'wave', 'cards', 'break', 'over']);
export const PHASE_CODE = Object.freeze({ warmup: 0, prep: 1, wave: 2, cards: 3, break: 4, over: 5 });
/** 좀비 행의 깃발 비트 */
export const ZF = Object.freeze({ dead: 1, wind: 2, rise: 4, slow: 8, haste: 16, armor: 32, rage: 64, air: 128, frozen: 256, hook: 512 });
/** 사람이 만든 장판 종류(스냅샷 af) */
export const FIELD_KINDS = Object.freeze({ fire: 1 });
/** 좀비 행의 종류 번호가 이 값 이상이면 보스(100 + 보스 번호) */
export const BOSS_CODE_BASE = 100;
/** 'z12' → 12, 그 밖은 0 */
export function zombieIdOf(v) {
  const s = String(v == null ? '' : v);
  if (s.length < 2 || s.length > 9 || s[0] !== 'z') return 0;
  const n = Number(s.slice(1));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
export const isZombieId = (v) => zombieIdOf(v) > 0;

/** 스냅샷 → 화면용 뷰. 형식이 틀리면 null(던지지 않는다) */
export function applyHordeSnapshot(s) {
  if (!s || typeof s !== 'object' || s.v !== HORDE_SNAPSHOT_VERSION || !Array.isArray(s.p) || !Array.isArray(s.z)) return null;
  const phase = HORDE_PHASES[s.zp | 0] || 'warmup';
  const players = [];
  // 살리는 사람 번호는 p 줄의 순서다(틀린 줄을 건너뛰어도 어긋나지 않게 원래 줄로 찾는다)
  const rowIds = s.p.map((r) => (Array.isArray(r) ? String(r[0]) : null));
  for (const r of s.p) {
    if (!Array.isArray(r) || r.length < 12) continue;
    const hurt = Array.isArray(r[16]) ? { x: fromCm(r[16][0]), z: fromCm(r[16][1]), ago: num(r[16][2]) } : null;
    const kn = Array.isArray(r[22]) ? r[22] : null;
    const dn = Array.isArray(r[23]) ? r[23] : null;
    const by = dn ? num(dn[4], -1) | 0 : -1;
    players.push({
      id: String(r[0]), name: String(r[1] || ''), hp: num(r[2]), maxHp: Math.max(1, num(r[3], 100)), alive: !!r[4], kills: num(r[5]) | 0,
      connected: !!r[6], cards: decodeCards(r[7]), offer: decodeCards(r[8]), rerolls: num(r[9]) | 0, picked: !!r[10], downs: num(r[11]) | 0,
      damage: num(r[12]) | 0, shield: num(r[13]) | 0, heads: num(r[14]) | 0, bossKills: num(r[15]) | 0, hurt, spawned: r[17] === undefined ? true : !!r[17],
      picks: num(r[18]) | 0, chest: !!r[19], offerLeftMs: num(r[20]) | 0, invuln: num(r[21]) > 0, invulnMs: num(r[21]) | 0,
      knock: kn ? { seq: num(kn[0]) | 0, v: [fromCm(kn[1]), fromCm(kn[2]), fromCm(kn[3])], ago: num(kn[4]) } : null,
      down: dn ? { pos: [fromCm(dn[0]), fromCm(dn[1]), fromCm(dn[2])], progress: clamp(num(dn[3]) / 1000, 0, 1), by: by >= 0 && rowIds[by] ? rowIds[by] : null } : null,
      burnMs: Math.max(0, num(r[24]) | 0), burnNextMs: Math.max(0, num(r[25]) | 0), noHealMs: Math.max(0, num(r[26]) | 0),
      yasuoHits: Array.isArray(r[27]) ? clamp(num(r[27][0]) | 0, 0, 2) : 0,
      yasuoStackMs: Array.isArray(r[27]) ? Math.max(0, num(r[27][1]) | 0) : 0,
      yasuoLastShot: Array.isArray(r[27]) ? Math.max(0, num(r[27][2]) | 0) : 0,
      yasuoLastAgo: Array.isArray(r[27]) ? Math.max(0, num(r[27][3]) | 0) : 0
    });
  }
  const zombies = [];
  for (const r of s.z) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const code = num(r[1]) | 0;
    const boss = code >= BOSS_CODE_BASE ? bossByCode(code - BOSS_CODE_BASE) : null;
    const type = boss ? null : zombieByCode(code);
    if (!boss && !type) continue;
    const f = num(r[7]) | 0;
    zombies.push({
      id: num(r[0]) | 0, code, boss, type, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], yaw: num(r[5]) / 100,
      hpFrac: clamp(num(r[6]) / 100, 0, 1), flags: f, dead: !!(f & ZF.dead)
    });
  }
  const pids = players.map((p) => p.id);
  const killers = new Map();
  for (const r of Array.isArray(s.kz) ? s.kz : []) if (Array.isArray(r) && pids[r[1]]) killers.set(num(r[0]) | 0, pids[r[1]]);
  for (const z of zombies) if (z.dead && killers.has(z.id)) z.killer = killers.get(z.id);
  const bosses = [];
  for (const r of Array.isArray(s.b) ? s.b : []) {
    const def = Array.isArray(r) ? bossByCode(r[1]) : null;
    if (!def) continue;
    bosses.push({
      id: num(r[0]) | 0, def, hp: num(r[2]), maxHp: Math.max(1, num(r[3], 1)), skill: num(r[4]) | 0, skillPhase: num(r[5]) | 0,
      target: [fromCm(r[6]), fromCm(r[7])], skillLeftMs: num(r[8]), ringR: num(r[9]) / 100, enraged: !!r[10]
    });
  }
  const projectiles = (Array.isArray(s.pr) ? s.pr : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], vel: [fromCm(r[5]), fromCm(r[6]), fromCm(r[7])], arc: !!r[8], owner: num(r[9]) | 0
  }));
  const hazards = (Array.isArray(s.hz) ? s.hz : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), leftMs: num(r[6]), ms: Math.max(1, num(r[7], 1))
  }));
  const fx = (Array.isArray(s.fx) ? s.fx : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: String(r[1] || ''), pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), ago: num(r[6])
  }));
  const loot = [];
  for (const r of Array.isArray(s.lt) ? s.lt : []) {
    const def = Array.isArray(r) ? lootByCode(r[1]) : null;
    if (!def) continue;
    loot.push({ id: num(r[0]) | 0, kind: def.id, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], leftMs: Math.max(0, num(r[5]) * 100) });
  }
  const fields = (Array.isArray(s.af) ? s.af : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), leftMs: num(r[6]), ms: Math.max(1, num(r[7], 1))
  }));
  const decoys = (Array.isArray(s.dc) ? s.dc : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, pos: [fromCm(r[1]), fromCm(r[2]), fromCm(r[3])], hpFrac: clamp(num(r[4]) / 100, 0, 1), owner: players[num(r[5], -1)] ? players[num(r[5])].id : null, leftMs: num(r[6])
  }));
  const swordWaves = (Array.isArray(s.yt) ? s.yt : []).filter((r) => Array.isArray(r) && rowIds[r[0]]).map((r) => ({
    owner: rowIds[r[0]], pos: [fromCm(r[1]), fromCm(r[2]), fromCm(r[3])], dir: [num(r[4]), 0, num(r[5])],
    left: fromCm(r[6]), hit: Array.isArray(r[7]) ? r[7].map((id) => num(id) | 0) : [], bossDone: r[8] === 1
  }));
  const xa = Array.isArray(s.xp) ? s.xp : [1, 0, 10, 0];
  return {
    mode: 'zombie', phase, stage: num(s.st) | 0, firstStage: Math.max(1, num(s.fs, 1) | 0), timeLeftMs: s.tl == null ? null : num(s.tl), elapsedMs: num(s.el), seed: num(s.sd) >>> 0,
    stageLeftMs: s.sl == null ? null : num(s.sl), xp: { level: Math.max(1, num(xa[0], 1) | 0), xp: num(xa[1]) | 0, need: Math.max(1, num(xa[2], 10) | 0), total: num(xa[3]) | 0 },
    left: num(s.left) | 0, total: num(s.tot) | 0, killedStage: num(s.kd) | 0, recentBosses: Array.isArray(s.rb) ? s.rb.map(String) : [],
    players, zombies, bosses, projectiles, hazards, fx, loot, fields, decoys, swordWaves, over: s.over && typeof s.over === 'object' ? { ...s.over } : null
  };
}

/** 방장 화면 결과 요약(계정 기록용): 내 처치·헤드샷·도달 스테이지 */
export function hordeSummary(view, meId) {
  const me = view && view.players ? view.players.find((p) => p.id === meId) : null;
  const over = (view && view.over) || {};
  return {
    stage: num(over.stage, view ? view.stage : 0) | 0, cleared: num(over.cleared, view ? Math.max(0, view.stage - view.firstStage) : 0) | 0, ms: num(over.ms, view ? view.elapsedMs : 0),
    kills: me ? me.kills : 0, heads: me ? me.heads : 0, bossKills: me ? me.bossKills : 0, downs: me ? me.downs : 0, damage: me ? me.damage : 0,
    cards: me ? me.cards.length : 0, level: view && view.xp ? view.xp.level : 1
  };
}
