/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 피해 공식(순수 함수). 좀비 한 발의 피해(부위·거리·관통·증강), 폭발 종류별 배율과 수류탄·발사체 피해를 둔다.
 *          방장 시뮬레이션(director.js)의 판정과 화면의 피해 숫자(client.js)가 같은 함수를 쓴다. director.js에서 옮겨 왔고 값은 그대로다.
 *          three.js·DOM에 의존하지 않아 게임 서버와 node 시험이 그대로 쓴다.
 */
import { computeDamage, getDef } from '../../weapons/defs.js';

const PIERCE_FALLOFF = 0.7;
const PIERCE_MIN = 0.3;           // 무제한 관통에서도 이만큼은 남는다(뚫을 때마다 70%, 최소 30%)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);

/**
 * 폭발 종류별 배율: 손으로 던진 수류탄 10(폭심 기본 피해 1000), 유탄 발사기 1.2(여러 발), 바주카포 2.6(한 발씩), 말뚝건 4.5(반경 1.2 m 안 450),
 * 투척 도끼 7(뚫고 지나가며 닿은 좀비마다 700), 제우스의 번개 1.5(맞은 좀비와 튄 다섯 마리 모두 150)
 */
export const BLAST_MUL = Object.freeze({ nade: 10, gl: 1.2, rocket: 2.6, stake: 4.5, axe: 7, bolt: 1.5 });

/** 대상별 피해 배율: 보스 피해 증가와 일반 좀비 피해 감소를 같은 경로로 적용한다. */
export function targetDamageMul(k, boss) {
  return boss ? 1 + ((k && k.boss) || 0) : 1 - Math.min(1, (k && k.normalPenalty) || 0);
}

/** 수류탄·발사체 폭발 피해(화면이 잰 피해 → 이 모드의 피해): 종류 배율 × 모든 피해 × 수류탄 피해(보스면 보스 피해도) */
export function nadeDamage(dmg, k, boss = false, kind = null) {
  const kk = k || {};
  const base = BLAST_MUL[kind] || BLAST_MUL.nade;
  const side = (kind === 'gl' || kind === 'rocket' || kind === 'stake') && (kk.sideMaster || 0) > 0 ? 6 : 1;   // 보조무기 마스터: 보조 발사기 피해 +500%
  return clamp(num(dmg), 0, 100) * base * (1 + (kk.dmg || 0)) * (1 + (kk.nade || 0)) * targetDamageMul(kk, boss) * side;
}

/**
 * 좀비 한 발의 피해(치명타·좀비 방어 버프 빼고). 방장 판정(claimHit)과 화면의 피해 숫자가 같은 공식을 쓴다.
 * c = { weaponId, part, dist, kind, count }, k = 쏜 사람의 능력치(computePerks), z = { boss, hpFrac }, o = { myHpFrac, nth(관통 순서), air(점프로 떠 있는가) }
 * kind: 'stab'·'waveStab'(찌르기의 검기)은 찌르기 피해, 'slash'·'wave'(베기의 검기)는 베기 피해. 검기도 칼 피해라 칼 증강이 붙는다
 * → { dmg, head, melee, part } | null(쓸 수 없는 무기)
 */
export function zombieHitDamage(c = {}, k = {}, z = {}, o = {}) {
  const def = getDef(c.weaponId);
  if (!def || def.explosion) return null;
  const melee = !!def.melee;
  let part = String(c.part || 'body');
  if (part === 'hand') part = 'body';
  else if (part === 'foot') part = 'legs';
  const dist = Math.max(0, num(c.dist));
  const count = clamp(num(c.count, 1) | 0, 1, Math.max(1, def.pellets || 1));
  const stab = c.kind === 'stab' || c.kind === 'waveStab';
  let base = computeDamage(def.id, part, dist, stab ? 'stab' : 'slash', count);
  // 보스 머리는 몸 피해의 2.2배까지만(라이플 머리 110이 보스를 몇 초 만에 녹이지 않게)
  if (z.boss && part === 'head' && !melee) base = Math.min(base, computeDamage(def.id, 'body', dist, undefined, count) * 2.2);
  let mul = 1 + (k.dmg || 0);
  const head = part === 'head' && !melee;
  if (head) mul *= 1 + (k.head || 0);
  else if (!melee && k.bodyPenalty > 0) mul *= 1 - Math.min(1, k.bodyPenalty);
  mul *= targetDamageMul(k, !!z.boss);
  if (melee) mul *= 1 + (k.melee || 0);
  if ((k.lastStand || 0) > 0 && num(o.myHpFrac, 1) <= 0.35) mul *= 1 + k.lastStand;
  if ((k.executioner || 0) > 0 && num(z.hpFrac, 1) <= 0.25) mul *= 1 + k.executioner;
  const nth = Math.max(0, num(o.nth, 0) | 0);
  if (nth > 0) mul *= Math.max(PIERCE_MIN, Math.pow(PIERCE_FALLOFF, nth));
  if ((k.airDmg || 0) > 0 && o.air && !melee) mul *= 1 + k.airDmg;   // 공중 강타: 총만(칼·수류탄 제외)
  if ((k.sideMaster || 0) > 0 && def.slot === 2) mul *= 6;   // 보조무기 마스터: 보조무기 피해 +500%
  return { dmg: base * mul, head, melee, part };
}
