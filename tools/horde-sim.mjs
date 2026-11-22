#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기를 화면 없이 여러 방 돌려 틱 시간·스냅샷 크기를 잰다(게임 서버 부하 가늠용). 방마다 대본 봇 4명, 30 Hz.
 *          사용: npm run sim:horde -- [--rooms 4] [--map restarea] [--stage 1] [--stages 5] [--seed 1] [--json]
 *          브라우저를 띄우지 않는다. 결과는 이 PC 기준이라 서버 사양에서는 다시 잰다.
 */
import { createHordeRoom } from '../js/game/horde/sim/room.js';
import { createHordeBot } from '../js/game/horde/sim/bots.js';
import { createDigest } from '../js/game/horde/sim/digest.js';

function parseArgs(argv) {
  const o = { rooms: 4, map: 'restarea', stage: 1, stages: 5, seed: 1, json: false, maxS: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a.startsWith('--') && i + 1 < argv.length) {
      const k = a.slice(2), v = argv[++i];
      if (k === 'map') o.map = String(v);
      else if (k in o) o[k] = Math.max(1, Number(v) | 0);
    }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (!/^[a-z0-9_-]+$/i.test(opts.map)) throw new Error('맵 이름이 이상해요: ' + opts.map);
const { default: MAP } = await import(`../js/maps/${opts.map}.js`);
const PLAYERS = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }, { id: 'p4', name: 'D' }];

const t0 = performance.now();
const rooms = [];
for (let r = 0; r < opts.rooms; r++) {
  const seed = opts.seed + r;
  const room = createHordeRoom({ map: MAP, players: PLAYERS, seed, startStage: opts.stage });
  const bots = PLAYERS.map((p) => createHordeBot({ id: p.id, seed, world: room.world }));
  const dg = createDigest();
  const feed = (ev) => { for (const b of bots) b.onEvents(ev); dg.add(ev); };
  feed(room.start());
  rooms.push({ room, bots, dg, feed, done: false });
}
const buildMs = performance.now() - t0;

const ticks = [];
let snapSum = 0, snapN = 0, snapMax = 0;
const until = opts.stage + opts.stages;
while (rooms.some((x) => !x.done)) {
  const s = performance.now();
  for (const x of rooms) {
    if (x.done) continue;
    const { room } = x;
    if (room.ticks % 3 === 0) {
      const view = room.view();
      for (const b of x.bots) {
        const { input, actions } = b.think(view, room.clockMs);
        room.input(b.id, input);
        for (const a of actions) room.send(b.id, a);
      }
      // 10 Hz로 보낼 스냅샷 크기
      const n = JSON.stringify(room.snapshot()).length;
      snapSum += n; snapN++; if (n > snapMax) snapMax = n;
    }
    x.feed(room.step());
    if (room.phase === 'over' || room.stage >= until || room.clockMs > opts.maxS * 1000) x.done = true;
  }
  ticks.push(performance.now() - s);
}

ticks.sort((a, b) => a - b);
const pct = (q) => ticks[Math.min(ticks.length - 1, Math.floor(ticks.length * q))];
const out = {
  map: opts.map, rooms: opts.rooms, startStage: opts.stage, buildMs: Math.round(buildMs), ticks: ticks.length,
  tickMs: { avg: +(ticks.reduce((a, b) => a + b, 0) / ticks.length).toFixed(3), p50: +pct(0.5).toFixed(3), p99: +pct(0.99).toFixed(2), max: +ticks[ticks.length - 1].toFixed(2) },
  snapshotBytes: { avg: Math.round(snapSum / Math.max(1, snapN)), max: snapMax },
  results: rooms.map((x) => ({ seed: x.room.seed, stage: x.room.stage, phase: x.room.phase, gameS: Math.round(x.room.clockMs / 1000), digest: x.dg.value }))
};
if (opts.json) console.log(JSON.stringify(out));
else {
  console.log(`맵 ${out.map} · 방 ${out.rooms}개 · ${out.startStage}스테이지부터 · 준비 ${out.buildMs} ms · 틱 ${out.ticks}번`);
  console.log(`한 틱(모든 방) 평균 ${out.tickMs.avg} ms · 중간 ${out.tickMs.p50} · p99 ${out.tickMs.p99} · 최대 ${out.tickMs.max} (30 Hz 예산 33.3 ms)`);
  console.log(`스냅샷 JSON 평균 ${out.snapshotBytes.avg} B · 최대 ${out.snapshotBytes.max} B (방 하나, 10 Hz로 보낼 때)`);
  for (const r of out.results) console.log(`  씨앗 ${r.seed}: ${r.stage}스테이지 ${r.phase} · ${r.gameS}초 · 지문 ${r.digest}`);
}
