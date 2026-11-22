/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 방이 손님 한 명에게 보내는 바이트를 스테이지마다 잰다. 소켓 없이 서버 좀비 방(core/horde-room.js)을 이 프로세스에서 시계보다 빠르게 돌리고,
 *          대본 봇 손님(sim/bots.js)이 받은 글자를 그대로 풀어(applyHordeSnapshot) 생각한 뒤 보낸 글자를 서버와 같은 검사(decodeClient)로 넣는다.
 *          WebSocket 프레임 머리(2~4바이트)는 세지 않는다. 실제 서버의 초당 바이트·틱 시간은 load.js --mode zombie로 잰다.
 */
/**
 *   node server/tools/horde-wire.js --map restarea --stages 9            # 1스테이지부터 9스테이지가 끝날 때까지
 *   node server/tools/horde-wire.js --map subway --start 18 --stages 3 --json
 *   node server/tools/horde-wire.js --start 9 --stages 1 --fire-ms 1500        # 덜 쏘는 봇: 좀비가 상한까지 쌓인 나쁜 경우
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCollision } from '../../js/maps/collision.js';
import { createHordeBot } from '../../js/game/horde/sim/bots.js';
import { applyHordeSnapshot } from '../../js/game/horde/wire.js';
import { createEventFilter, encodeHordeAction, encodeHordeState } from '../../js/net/hordeproto.js';
import { createHordeServerRoom } from '../core/horde-room.js';
import { mapData } from '../core/maps.js';
import { decodeClient } from '../core/protocol.js';

/**
 * @param {object} o { map, start, stages, players, seed, maxSec, snapHz, bot }   bot = createHordeBot 옵션 덮어쓰기(예: 덜 쏘게 해서 좀비가 쌓인 경우)
 * @returns {{ map, perStage: Array, total: object, snapAvg: number, snapMax: number, maxMsg: number }}
 */
export function measureHordeWire(o = {}) {
  const map = o.map || 'restarea';
  const start = o.start || 1;
  const stages = o.stages || 3;
  const n = o.players || 4;
  const seed = o.seed || 20261123;
  const maxSec = o.maxSec || 1800;
  const hz = 30;
  const world = buildCollision(mapData(map)).world;
  const inbox = [];                      // [pid, text] 서버가 보낸 것(이 틱 뒤에 손님이 읽는다)
  const room = createHordeServerRoom({
    send: (pid, text) => inbox.push([pid, text]), id: 'wire', map, hz, startStage: start > 1 ? start : undefined, seed, snapHz: o.snapHz
  });
  const clients = [];
  for (let i = 0; i < n; i++) {
    const id = `p${i + 1}`;
    room.join(id, { name: `봇${i + 1}` });
    clients.push({ id, bot: createHordeBot({ id, seed, world, reroll: i === 0, weaponId: i === 3 ? 'sg_pump' : 'ar_std', ...(o.bot || {}) }), accept: createEventFilter(), bytes: 0 });
  }
  const byId = new Map(clients.map((c) => [c.id, c]));
  const toServer = (pid, obj) => {
    if (!obj) return;
    const res = decodeClient(JSON.stringify(obj));
    if (res.ok) room.input(pid, res.msg);
  };
  toServer('p1', { t: 'start' });
  const perStage = new Map();   // 스테이지 → { ticks, bytes(사람 1명 평균), msgs, zombiesMax, secMax(1초 창 최대 바이트) }
  let snapCount = 0, snapBytes = 0, snapMax = 0, maxMsg = 0;
  let winBytes = 0, winTicks = 0;
  const lastStage = start + stages - 1;
  let stage = start;
  for (let t = 0; t < maxSec * hz; t++) {
    room.tick();
    stage = room.stage || stage;
    const row = perStage.get(stage) || { stage, ticks: 0, bytes: 0, msgs: 0, zombiesMax: 0, secMax: 0, boss: false };
    perStage.set(stage, row);
    row.ticks++;
    let tickBytes = 0;
    for (const [pid, text] of inbox.splice(0)) {
      const c = byId.get(pid);
      if (!c) continue;
      const b = Buffer.byteLength(text);
      c.bytes += b;
      tickBytes += b;
      if (b > maxMsg) maxMsg = b;
      const m = JSON.parse(text);
      if (m.t === 'zev') c.bot.onEvents(m.events.filter(c.accept));
      else if (m.t === 'zsnap') {
        c.bot.onEvents((m.ev || []).filter(c.accept));
        if (pid === 'p1') { snapCount++; snapBytes += b; if (b > snapMax) snapMax = b; }
        const view = applyHordeSnapshot(m.s);
        if (!view) continue;
        if (pid === 'p1') {
          row.zombiesMax = Math.max(row.zombiesMax, view.zombies.filter((z) => !z.dead).length);
          if (view.bosses.length) row.boss = true;
        }
        const { input, actions } = c.bot.think(view, (m.tick * 1000) / hz);
        toServer(pid, encodeHordeState(input));
        for (const a of actions) toServer(pid, encodeHordeAction(a));
      }
    }
    row.bytes += tickBytes / n;
    row.msgs++;
    winBytes += tickBytes / n;
    if (++winTicks >= hz) { row.secMax = Math.max(row.secMax, winBytes); winBytes = 0; winTicks = 0; }
    if (room.phase === 'over' || stage > lastStage) break;
  }
  const rows = [...perStage.values()].filter((r) => r.stage <= lastStage).map((r) => ({
    stage: r.stage, boss: r.boss, sec: Math.round((r.ticks / hz) * 10) / 10, zombiesMax: r.zombiesMax,
    kbPerSec: Math.round((r.bytes / (r.ticks / hz) / 1024) * 100) / 100, kbPerSecMax: Math.round((r.secMax / 1024) * 100) / 100
  }));
  const totalTicks = rows.reduce((s, r) => s + r.sec, 0);
  const totalBytes = [...perStage.values()].filter((r) => r.stage <= lastStage).reduce((s, r) => s + r.bytes, 0);
  const st = room.stats();
  room.dispose();
  return {
    map, players: n, start, reached: stage, phase: st.phase, perStage: rows,
    total: { sec: Math.round(totalTicks), kbPerSec: totalTicks ? Math.round((totalBytes / totalTicks / 1024) * 100) / 100 : 0, kbPerSecMax: Math.max(0, ...rows.map((r) => r.kbPerSecMax)) },
    snapAvg: snapCount ? Math.round(snapBytes / snapCount) : 0, snapMax, maxMsg, resentPerSnap: st.snapshots ? Math.round((st.resent / st.snapshots) * 10) / 10 : 0
  };
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      map: { type: 'string', default: 'restarea' }, start: { type: 'string', default: '1' }, stages: { type: 'string', default: '9' },
      players: { type: 'string', default: '4' }, seed: { type: 'string', default: '20261123' }, 'snap-hz': { type: 'string', default: '10' }, 'fire-ms': { type: 'string' }, json: { type: 'boolean' }
    }
  });
  const r = measureHordeWire({
    map: values.map, start: Number(values.start), stages: Number(values.stages), players: Number(values.players), seed: Number(values.seed), snapHz: Number(values['snap-hz']),
    bot: values['fire-ms'] ? { fireMs: Number(values['fire-ms']), nadeMs: 1e9 } : undefined
  });
  console.log(`${r.map} 손님 ${r.players}명, ${r.start}→${r.reached}스테이지(${r.phase}), 손님 한 명이 받는 양(WebSocket 머리 제외)`);
  for (const s of r.perStage) console.log(`  ${String(s.stage).padStart(3)}스테이지${s.boss ? '(보스)' : '      '} ${String(s.sec).padStart(6)}초 좀비 최대 ${String(s.zombiesMax).padStart(3)} · 평균 ${s.kbPerSec} KB/s · 1초 최대 ${s.kbPerSecMax} KB/s`);
  console.log(`  전체 ${r.total.sec}초 평균 ${r.total.kbPerSec} KB/s · 1초 최대 ${r.total.kbPerSecMax} KB/s · 스냅샷 평균 ${r.snapAvg} B 최대 ${r.snapMax} B · 다시 실은 이벤트 ${r.resentPerSnap}개/스냅샷`);
  if (values.json) console.log(JSON.stringify(r));
}
