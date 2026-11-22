/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버 좀비 방의 손님 메시지 검사(zs·zhit·zswing·zboom·zcard·zloot·zrev). 틀린 값은 버리고, 맞는 값은 좀비 방(horde-room.js)이 바로 쓸 모양으로 정리한다.
 *          protocol.js의 decodeClient가 이 검사표를 함께 쓴다. 형식 표는 js/net/hordeproto.js 머리말과 docs/HORDE_SERVER.md 8절.
 */
import { HORDE_BOOM_MAX, HORDE_CLIENT_TYPES } from '../../js/net/hordeproto.js';

export { HORDE_CLIENT_TYPES };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ID_RE = /^[A-Za-z0-9_#:-]{1,24}$/;
const POS_MAX = 5000;         // 맵 밖의 엉뚱한 값은 버린다(m)
const DIST_MAX = 1000;
const okPos = (v) => isNum(v) && Math.abs(v) <= POS_MAX;
const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max && ID_RE.test(v) ? v : null);
const optStr = (v, max) => (v === undefined || v === null ? undefined : str(v, max));

/** 형식별 검사. 틀리면 null(메시지를 버린다) */
export const HORDE_DECODERS = Object.freeze({
  zs(v) {
    if (v.alive === false) return { t: 'zs', alive: false };
    if (!okPos(v.x) || !okPos(v.z) || (v.y !== undefined && !okPos(v.y))) return null;
    const yaw = v.yaw === undefined || v.yaw === null ? null : isNum(v.yaw) && Math.abs(v.yaw) < 1e4 ? v.yaw : NaN;
    if (Number.isNaN(yaw)) return null;
    const slot = v.slot === undefined || v.slot === null ? null : Number.isInteger(v.slot) && v.slot >= 0 && v.slot <= 9 ? v.slot : NaN;
    if (Number.isNaN(slot)) return null;
    return { t: 'zs', x: v.x, y: isNum(v.y) ? v.y : 0, z: v.z, yaw, slot, air: v.air === true, alive: true };
  },
  zhit(v) {
    const victimId = str(v.victimId, 10), weaponId = str(v.weaponId, 24);
    if (!victimId || !weaponId) return null;
    if (v.dist !== undefined && !(isNum(v.dist) && v.dist >= 0 && v.dist <= DIST_MAX)) return null;
    const part = optStr(v.part, 12), kind = optStr(v.kind, 16);
    if (part === null || kind === null) return null;
    const count = v.count === undefined ? 1 : Number.isInteger(v.count) && v.count >= 1 && v.count <= 16 ? v.count : 0;
    if (!count) return null;
    const shotId = v.shotId === undefined ? 0 : Number.isSafeInteger(v.shotId) && v.shotId >= 0 ? v.shotId : -1;
    if (shotId < 0) return null;
    return { t: 'zhit', victimId, weaponId, part, dist: isNum(v.dist) ? v.dist : 0, kind, count, shotId };
  },
  zswing(v) {
    const weaponId = str(v.weaponId, 24), kind = str(v.kind, 16);
    if (!weaponId || !kind || !Number.isSafeInteger(v.shotId) || v.shotId < 0) return null;
    return { t: 'zswing', weaponId, kind, shotId: v.shotId };
  },
  zboom(v) {
    if (!Array.isArray(v.c) || v.c.length !== 3 || !v.c.every(okPos)) return null;
    if (!Array.isArray(v.v) || v.v.length > HORDE_BOOM_MAX) return null;
    const victims = [];
    for (const r of v.v) {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isInteger(r[0]) || r[0] <= 0 || !isNum(r[1]) || r[1] < 0 || r[1] > 100000) return null;
      victims.push({ id: 'z' + r[0], dmg: r[1] });
    }
    const kind = optStr(v.k, 16);
    if (kind === null) return null;
    return { t: 'zboom', center: { x: v.c[0], y: v.c[1], z: v.c[2] }, victims, kind };
  },
  zcard(v) {
    if (v.act === 'reroll') return { t: 'zcard', act: 'reroll' };
    if (v.act !== 'pick') return null;
    const card = str(v.card, 16);
    return card ? { t: 'zcard', act: 'pick', card } : null;
  },
  zloot(v) {
    return Number.isInteger(v.id) && v.id > 0 && v.id <= 0x7fffffff ? { t: 'zloot', id: v.id } : null;
  },
  zrev(v) {
    const id = str(v.id, 24);
    return id ? { t: 'zrev', id, on: v.on === 1 || v.on === true } : null;
  }
});
