/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 화면 없는 좀비 방(sim/room.js)에 넣는 대본 봇. 스폰 자리 둘레를 조금씩 움직이며 가장 가까운 좀비를 쏘고, 좀비가 몰리면 수류탄을 던지고,
 *          증강 제안이 오면 고르고(다시 뽑기도 한 번), 가까운 보급품을 줍고, 쓰러진 동료가 있으면 가서 살린다.
 *          자기 씨앗의 난수만 쓰므로 같은 씨앗·같은 판이면 같은 입력을 낸다(결정성 시험·서버 부하 측정용). 실제 사람의 조준·벽 가림은 흉내 내지 않는다.
 */
/**
 * const bot = createHordeBot({ id: 'p1', seed: 7 });
 * bot.onEvents(ev);                                  // room.start()·room.step()이 낸 이벤트(내 스폰 자리를 읽는다)
 * const { input, actions } = bot.think(view, clockMs);   // view = room.view()
 * room.input(bot.id, input); actions.forEach((a) => room.send(bot.id, a));
 */
import { makeRng, hashSeed, HORDE } from '../rules.js';
import { getDef } from '../../../weapons/defs.js';
import { getGroundY } from '../../../engine/physics.js';

const NADE_R = 5;

/**
 * @param {object} o
 * @param {string} o.id
 * @param {number} [o.seed]
 * @param {string} [o.weaponId='ar_std']   주무기(이 무기의 사거리 안 좀비만 쏜다)
 * @param {number} [o.fireMs=110]          한 발 간격
 * @param {number} [o.nadeMs=8000]         수류탄 간격
 * @param {boolean} [o.reroll=false]       제안마다 다시 뽑기를 한 번 써 본다
 * @param {object} [o.world]               충돌 월드(발 높이를 바닥에 맞춘다). 없으면 스폰 높이 그대로
 */
export function createHordeBot(o = {}) {
  const id = String(o.id);
  const rng = makeRng(hashSeed(Number(o.seed) >>> 0, 'bot', id));
  const def = getDef(o.weaponId || 'ar_std');
  const weaponId = def ? def.id : 'ar_std';
  const range = def && def.maxRange ? def.maxRange * 0.9 : 60;
  const fireMs = Math.max(30, Number(o.fireMs) || 110);
  const nadeMs = Math.max(500, Number(o.nadeMs) || 8000);
  const world = o.world || null;
  const phase = rng() * Math.PI * 2;
  let anchor = null;            // 스폰 자리 [x, y, z]
  let pos = null;
  let shotId = 0, nextFire = 0, nextNade = nadeMs * (0.5 + rng() * 0.5);
  let offerKey = '', rerolled = false;

  const groundAt = (x, z, y) => {
    if (!world) return y;
    const g = getGroundY(world, x, z, y + 1.5);
    return Number.isFinite(g) ? g : y;
  };

  function onEvents(ev) {
    for (const e of ev || []) {
      if (e && e.type === 'spawn' && e.id === id && e.spawn) {
        const y = Number.isFinite(e.spawn.y) ? e.spawn.y : 0;
        anchor = [e.spawn.x, groundAt(e.spawn.x, e.spawn.z, y), e.spawn.z];
        pos = anchor.slice();
      }
    }
  }

  const d2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

  /** 한 번 생각한다 → 이번에 보낼 상태와 행동 */
  function think(view, clockMs) {
    const actions = [];
    const me = view && view.players ? view.players.find((p) => p.id === id) : null;
    if (!me || !anchor) return { input: { alive: false }, actions };
    if (!me.alive) return { input: { alive: false }, actions };
    const live = view.zombies.filter((z) => !z.dead);
    // 가야 할 곳: 쓰러진 동료 → 가까운 보급품(주변이 조용할 때) → 스폰 둘레
    let goal = null;
    const down = view.players.find((p) => p.id !== id && !p.alive && p.down && p.connected);
    // 살리러 가는 사람은 하나만: 명단 순서로 첫 번째, 살아 있고 증강을 고르는 중이 아닌 사람
    const helper = down ? view.players.find((p) => p.alive && p.connected && p.id !== down.id && !p.offer.length) : null;
    if (down && helper && helper.id === id) {
      goal = [down.down.pos[0] + 0.6, down.down.pos[1], down.down.pos[2]];
      if (pos && d2(pos, down.down.pos) <= HORDE.reviveRangeM) actions.push({ t: 'revive', targetId: down.id, on: true });
    }
    const near = live.filter((z) => pos && d2(pos, z.pos) < 8).length;
    if (!goal && !near && pos) {
      let best = null, bd = 12;
      for (const L of view.loot || []) { const d = d2(pos, L.pos); if (d < bd) { bd = d; best = L; } }
      if (best) goal = best.pos.slice();
    }
    if (!goal) {
      const t = clockMs / 1000;
      goal = [anchor[0] + Math.sin(t * 0.9 + phase) * 1.5, anchor[1], anchor[2] + Math.cos(t * 0.7 + phase) * 1.5];
    }
    // 한 번에 최대 0.6 m(10 Hz로 생각하면 6 m/s)씩 다가간다
    const cur = pos || anchor;
    const dx = goal[0] - cur[0], dz = goal[2] - cur[2], dl = Math.hypot(dx, dz);
    const stepM = Math.min(dl, 0.6);
    const nx = dl > 1e-6 ? cur[0] + (dx / dl) * stepM : cur[0];
    const nz = dl > 1e-6 ? cur[2] + (dz / dl) * stepM : cur[2];
    pos = [nx, groundAt(nx, nz, cur[1]), nz];
    // 보급품: 닿으면 줍는다
    for (const L of view.loot || []) if (d2(pos, L.pos) <= HORDE.lootPickM * 0.8) actions.push({ t: 'loot', lootId: L.id });
    // 증강: 새 제안이면 (원하면 다시 뽑기 한 번 뒤) 하나 고른다
    if (me.offer.length && !me.picked) {
      const key = me.offer.join(',');
      if (key !== offerKey) {
        offerKey = key;
        if (o.reroll && !rerolled && me.rerolls > 0) { rerolled = true; actions.push({ t: 'reroll' }); }
        else { rerolled = false; actions.push({ t: 'pick', cardId: me.offer[Math.floor(rng() * me.offer.length)] }); }
      }
    } else if (!me.offer.length) { offerKey = ''; rerolled = false; }
    // 사격: 가장 가까운 좀비(사거리 안). 다섯 발에 한 번은 머리
    let target = null, td = range, yaw = null;
    for (const z of live) { const d = Math.hypot(z.pos[0] - pos[0], z.pos[1] - pos[1], z.pos[2] - pos[2]); if (d < td) { td = d; target = z; } }
    if (target) yaw = Math.atan2(-(target.pos[0] - pos[0]), -(target.pos[2] - pos[2]));
    if (target && clockMs >= nextFire && !me.offer.length) {
      nextFire = clockMs + fireMs;
      shotId++;
      actions.push({ t: 'hit', victimId: 'z' + target.id, weaponId, part: shotId % 5 === 0 ? 'head' : 'body', dist: Math.round(td * 100) / 100, kind: 'shot', count: 1, shotId });
    }
    // 수류탄: 셋 넘게 몰려 있으면 가장 가까운 좀비 자리에
    if (target && clockMs >= nextNade && td < 20) {
      const c = target.pos;
      const victims = [];
      for (const z of live) {
        const d = Math.hypot(z.pos[0] - c[0], z.pos[1] - c[1], z.pos[2] - c[2]);
        if (d <= NADE_R) victims.push({ id: 'z' + z.id, dmg: Math.round(100 * (1 - d / NADE_R)) });
      }
      if (victims.length >= 3) {
        nextNade = clockMs + nadeMs;
        actions.push({ t: 'explode', center: { x: c[0], y: c[1], z: c[2] }, victims });
      }
    }
    return { input: { x: pos[0], y: pos[1], z: pos[2], yaw, slot: 1, air: false, alive: true }, actions };
  }

  return { id, onEvents, think, get pos() { return pos; } };
}
