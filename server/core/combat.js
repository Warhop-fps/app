/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버의 사격·칼 판정. 사격 이벤트의 펠릿을 모두 physics.traceShot으로 따라가 맞은 사람마다 한 건으로 묶고(브라우저 world.js localFire와 같은 규칙),
 *          칼 판정 meleeTrace를 옮겨 둔다. 대상 목록은 room이 되감은 자리로 만들어 넘긴다.
 */
/**
 * meleeTrace는 js/game/world.js의 같은 이름 함수를 그대로 옮긴 것이다. world.js가 three.js를 불러 node에서 import할 수 없어서다.
 * 칼 규칙을 바꿀 때는 두 곳을 함께 고친다. 다음 단계에서 순수 모듈로 빼 브라우저와 서버가 한 파일을 쓰게 한다(docs/SERVER.md 8절).
 */
import { traceShot, raycastPlayers, lineOfSight } from '../../js/engine/physics.js';
import { shotDirection } from '../../js/weapons/logic.js';

/** 부위 순위(작을수록 좋다). 산탄 한 발이 같은 사람의 여러 부위를 맞히면 가장 좋은 부위 하나로 주장한다(world.js와 같다) */
export const PART_RANK = Object.freeze({ head: 0, body: 1, legs: 2, hand: 3, foot: 4 });

/** 칼의 원뿔 판정에서 몸을 원기둥으로 볼 때의 반지름(m, world.js와 같다) */
const BODY_R = 0.3;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** 눈 → 점을 보는 yaw·pitch와 수평 거리(yaw 0 = -Z, 전방 = (-sin yaw, -cos yaw), consts.js 좌표 규약). 가짜 클라이언트와 시험이 겨눌 때 쓴다 */
export function aimAt(eye, point) {
  const dx = point[0] - eye[0], dy = point[1] - eye[1], dz = point[2] - eye[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), dist: Math.hypot(dx, dz) };
}

/**
 * 사격 한 번. 펠릿마다 탄 방향(시점 + 반동 + 탄퍼짐)을 traceShot으로 따라간다. 벽이 먼저면 사람을 맞히지 않는다.
 * @param {object} world physics world
 * @param {number[]} eye 사격 원점(눈)
 * @param {number} yaw 시점(반동 전)
 * @param {number} pitch
 * @param {object} ev arsenal의 fire 이벤트(pellets·recoil)
 * @param {object[]} targets raycastPlayers 대상 [{ id, pos, yaw, crouch, alive }]
 * @param {number} range 사거리(m)
 * @returns {{victims:Array<{id:string, part:string, dist:number, count:number, point:number[]}>, shown:object}}
 *   victims = 맞은 사람마다 한 건(가장 좋은 부위, 맞은 펠릿 수). shown = 연출용 탄 하나(사람을 맞힌 첫 펠릿, 없으면 첫 펠릿)
 */
export function resolveShot(world, eye, yaw, pitch, ev, targets, range) {
  const pellets = ev.pellets && ev.pellets.length ? ev.pellets.length : 1;
  const byVictim = new Map();
  let shown = null;
  for (let i = 0; i < pellets; i++) {
    const dv = shotDirection(yaw, pitch, ev, i);
    const hit = traceShot(world, eye, [dv[0], dv[1], dv[2]], range, targets);
    if (!shown || (hit.kind === 'player' && shown.kind !== 'player')) shown = hit;
    if (hit.kind !== 'player') continue;
    const v = byVictim.get(hit.id);
    if (!v) byVictim.set(hit.id, { id: hit.id, part: hit.part, dist: round2(hit.dist), count: 1, point: r3(hit.point) });
    else {
      v.count++;
      if (PART_RANK[hit.part] < PART_RANK[v.part]) { v.part = hit.part; v.dist = round2(hit.dist); v.point = r3(hit.point); }
    }
  }
  return { victims: [...byVictim.values()], shown };
}

/**
 * 근접(칼) 판정: 정확한 레이가 먼저, 없으면 시선 원뿔(arc) 안 + 사거리 안 + 벽에 안 가린 가장 가까운 대상(js/game/world.js와 같다).
 * @returns {{ id, part, dist, point } | null}  dist = 몸 표면까지 거리(m)
 */
export function meleeTrace(world, eye, fwd, range = 1.8, arc = 0.6, targets = [], ignoreId) {
  const f = norm3(fwd);
  const ray = raycastPlayers(eye, f, range, targets, ignoreId != null ? { ignoreId } : null);
  if (ray && (!world || lineOfSight(world, eye, ray.point))) {
    return { id: ray.id, part: ray.part, dist: round2(ray.dist), point: r3(ray.point) };
  }
  let best = null, bestScore = Infinity;
  for (const tg of targets) {
    if (!tg || tg.alive === false || (ignoreId != null && tg.id === ignoreId)) continue;
    const p = tg.pos;
    const top = tg.crouch ? 1.5 - 0.45 * Math.min(1, +tg.crouch || 0) : 1.5;   // 앉으면 몸통 윗면 1.05 m
    const cy = clamp(eye[1], p[1] + 0.5, p[1] + top);      // 눈높이에 가장 가까운 몸 높이
    const dx = p[0] - eye[0], dy = cy - eye[1], dz = p[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    const surf = Math.max(0, dist - BODY_R);
    if (surf > range) continue;
    const cos = dist > 1e-6 ? (dx * f[0] + dy * f[1] + dz * f[2]) / dist : 1;
    const ang = Math.acos(clamp(cos, -1, 1));
    if (ang > arc + Math.atan2(BODY_R, Math.max(BODY_R, dist))) continue;
    const pt = [p[0], cy, p[2]];
    if (world && !lineOfSight(world, eye, pt)) continue;
    const score = ang * 2 + surf;
    if (score < bestScore) { bestScore = score; best = { id: tg.id, part: 'body', dist: round2(surf), point: r3(pt) }; }
  }
  return best;
}
