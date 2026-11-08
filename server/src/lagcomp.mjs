/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 지연 보정(lag compensation)용 위치 기록. 틱마다 사람 자리(발 위치·yaw·앉음·생존)를 링 버퍼에 남기고,
 *          쏜 사람이 화면에 그린 틱(소수)으로 되감아 그 순간의 자리를 보간해 돌려준다. 되감기 상한은 rewindTarget이 자른다.
 */
/**
 * 시간 기준: 기록 k = 서버가 틱 k를 끝낸 뒤의 자리 = 스냅샷 k에 실린 자리. 클라이언트는 받은 스냅샷 사이를 보간해 그리므로,
 * 그린 순간을 틱 단위 소수(vt)로 알려 주면 서버가 같은 두 기록을 같은 비율로 섞어 그 화면을 다시 만든다.
 */
import { lerpAngle } from '../../js/engine/interp.js';

/** 한 틱 사이에 이보다 멀리(m) 옮겼으면 스폰·포털 순간이동이다. 두 자리를 섞지 않고 가까운 쪽을 쓴다 */
export const TELEPORT_DIST = 4;

/**
 * @param {{size?:number}} [opts] size = 남겨 둘 틱 수(되감기 상한보다 넉넉하게)
 */
export function createHistory({ size = 64 } = {}) {
  const slots = new Array(size).fill(null);
  let first = -1;
  let newest = -1;

  const entry = (t) => {
    const e = slots[((t % size) + size) % size];
    return e && e.tick === t ? e : null;
  };

  return {
    /**
     * 틱 하나의 자리를 남긴다. 틱 번호는 1씩 늘어야 한다.
     * @param {number} tick
     * @param {Array<{id:string, team:string|null, x:number, y:number, z:number, yaw:number, crouch:number, alive:boolean}>} rows
     */
    record(tick, rows) {
      slots[((tick % size) + size) % size] = { tick, rows: rows.map((r) => ({ ...r })) };
      if (first < 0) first = tick;
      newest = tick;
    },

    /** 남아 있는 틱 범위. 아직 없으면 null */
    range() {
      return newest < 0 ? null : { oldest: Math.max(first, newest - size + 1), newest };
    },

    /**
     * 소수 틱 t의 자리(범위 안으로 잘라서 부른다). 두 기록 모두에 있는 사람만 섞고, 순간이동이면 가까운 쪽을 쓴다.
     * 생존은 두 기록 모두 살아 있어야 산 것으로 본다(사이에서 죽었으면 맞히지 못한다).
     * @returns {Array<object>|null} record에 준 모양의 새 배열
     */
    sample(t) {
      const a = Math.floor(t);
      const f = t - a;
      const A = entry(a);
      if (!A) return null;
      const B = f > 1e-6 ? entry(a + 1) : null;
      if (!B) return A.rows.map((r) => ({ ...r }));
      const next = new Map(B.rows.map((r) => [r.id, r]));
      return A.rows.map((ra) => {
        const rb = next.get(ra.id);
        if (!rb) return { ...ra };
        if (Math.hypot(rb.x - ra.x, rb.y - ra.y, rb.z - ra.z) > TELEPORT_DIST) return { ...(f < 0.5 ? ra : rb) };
        return {
          id: ra.id,
          team: rb.team,
          x: ra.x + (rb.x - ra.x) * f,
          y: ra.y + (rb.y - ra.y) * f,
          z: ra.z + (rb.z - ra.z) * f,
          yaw: lerpAngle(ra.yaw, rb.yaw, f),
          crouch: ra.crouch + (rb.crouch - ra.crouch) * f,
          alive: ra.alive && rb.alive
        };
      });
    }
  };
}

/**
 * 되감을 틱을 정한다. vt(클라이언트가 그린 틱)를 [now − maxTicks, newest] 안으로 자른다.
 * vt가 없거나 미래면 newest(되감지 않음 = 서버가 지금 알고 있는 자리)다.
 * 상한 아래로 우기는 값은 상한으로 자른다. 지연이 아주 큰 사람(또는 지난 화면을 우기는 조작)이 벽 뒤로 숨은 사람을 맞히지 못하게 한다.
 * @param {number|null} vt
 * @param {{now:number, maxTicks:number, oldest:number, newest:number}} w  now = 지금 계산 중인 틱
 * @returns {{tick:number, clamped:boolean, rewind:number}}  rewind = now − tick(틱)
 */
export function rewindTarget(vt, { now, maxTicks, oldest, newest }) {
  const lo = Math.max(oldest, Math.min(newest, now - maxTicks));
  let tick = Number.isFinite(vt) ? vt : newest;
  let clamped = false;
  if (tick < lo) { tick = lo; clamped = true; }
  if (tick > newest) tick = newest;
  return { tick, clamped, rewind: now - tick };
}
