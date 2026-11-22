/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 부하 측정 명령. 떠 있는 게임 서버에 개인전 방 여러 개 × 가짜 클라이언트(싸우고, 죽으면 즉시 부활)를 붙여 정한 시간 동안 돌리고,
 *          서버의 /healthz(최근 30초 틱 p50·p95·최대, CPU, 메모리, 초당 보낸 바이트)를 5초마다 읽어 요약을 낸다. 경기가 끝나면 방장이 다시 시작한다.
 *          --mode zombie면 좀비 방 여러 개 × 대본 봇 손님 4명(horde-client.js, sim/bots.js)을 붙인다.
 */
/**
 *   npm run server -- --max-per-ip 1000 --max-rooms-per-ip 100 --log-level warn   # 다른 창
 *   node server/tools/load.js --rooms 4 --bots 8 --seconds 180
 *   node server/tools/load.js --mode zombie --map restarea --rooms 4 --seconds 180   # 좀비 방(방마다 4명)
 *
 * 가짜 클라이언트도 같은 PC에서 돌면 서버와 CPU를 나눠 쓴다. 숫자는 서버 프로세스 것만(/healthz) 적는다.
 */
import { parseArgs } from 'node:util';
import { createFakeClient } from './fake-client.js';
import { createHordeFakeClient } from './horde-client.js';

const USAGE = `사용법: node server/tools/load.js [옵션]
  --url <ws://…>     서버 주소 (기본 ws://127.0.0.1:8787)
  --rooms <n>        방 수 (기본 1)
  --bots <n>         방마다 가짜 클라이언트 2~16 (기본 8)
  --seconds <n>      측정 시간(초, 기본 120). 시작 뒤 10초는 데우기라 요약에서 뺀다
  --latency <ms>     한쪽 지연 (기본 30)    --jitter <ms> (기본 10)
  --kill-target <n>  목표 킬 5~20 (기본 20)
  --mode <ffa|zombie> 방 종류 (기본 ffa). zombie면 --bots는 1~4(기본 4), --map은 restarea·subway
  --map <id>         좀비 방 맵 (기본 restarea)
  --json             마지막 줄에 요약 JSON`;

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:8787' },
    rooms: { type: 'string', default: '1' },
    bots: { type: 'string', default: '8' },
    seconds: { type: 'string', default: '120' },
    latency: { type: 'string', default: '30' },
    jitter: { type: 'string', default: '10' },
    'kill-target': { type: 'string', default: '20' },
    mode: { type: 'string', default: 'ffa' },
    map: { type: 'string', default: 'restarea' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
});
if (values.help) { console.log(USAGE); process.exit(0); }
const zombie = values.mode === 'zombie';
const rooms = Number(values.rooms), seconds = Number(values.seconds);
const bots = zombie && values.bots === '8' ? 4 : Number(values.bots);
if (!Number.isInteger(rooms) || rooms < 1 || rooms > 100) { console.error(`--rooms: 1~100\n\n${USAGE}`); process.exit(2); }
if (zombie ? !Number.isInteger(bots) || bots < 1 || bots > 4 : !Number.isInteger(bots) || bots < 2 || bots > 16) { console.error(`--bots: ${zombie ? '1~4' : '2~16'}\n\n${USAGE}`); process.exit(2); }
const httpUrl = values.url.replace(/^ws/, 'http');
const tag = Date.now().toString(36).slice(-6);
const WARMUP_SEC = 10;

const all = [];
const leaders = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthz() {
  try { return await (await fetch(`${httpUrl}/healthz`)).json(); } catch { return null; }
}

for (let r = 0; r < rooms; r++) {
  const room = `ld${tag}${r}`;
  const clients = [];
  for (let i = 0; i < bots; i++) {
    const c = zombie
      ? createHordeFakeClient({ url: values.url, room, name: `봇${r}-${i}`, map: values.map, seed: r * 16 + i + 1, latencyMs: Number(values.latency), bot: { reroll: i === 0, weaponId: i === 3 ? 'sg_pump' : 'ar_std' } })
      : createFakeClient({
      url: values.url, room, name: `봇${r}-${i}`, behavior: 'fight', quickRespawn: true,
      latencyMs: Number(values.latency), jitterMs: Number(values.jitter), opts: { mode: 'ffa', killTarget: Number(values['kill-target']) }
    });
    clients.push(c);
    all.push(c);
    await c.ready;
  }
  if (zombie) await clients[0].waitFor((s) => s.lobby && s.lobby.players.length === bots, 10000, '전원 입장');
  else await clients[0].waitFor((c) => c.match && c.match.p.length === bots, 10000, '전원 입장');
  clients[0].start();
  leaders.push(clients[0]);
}
console.log(`방 ${rooms}개 × ${bots}명 = ${all.length}명 입장, ${seconds}초 측정 (앞 ${WARMUP_SEC}초 데우기)`);

// 경기가 끝나면 방장이 다시 시작한다(경기 끝 → 대기실 → 시작)
const restarter = setInterval(() => {
  for (const l of leaders) {
    if (zombie) { if (l.state.phase === 'over') l.start(); continue; }
    if (l.phase === 'matchEnd' || l.phase === 'warmup') l.start();
  }
}, 1000);

const samples = [];
const t0 = performance.now();
while ((performance.now() - t0) / 1000 < seconds) {
  await sleep(5000);
  const h = await healthz();
  const sec = (performance.now() - t0) / 1000;
  if (!h || !h.live) continue;
  const l = h.live;
  const stageNow = zombie ? ` 스테이지 ${Math.max(...leaders.map((l) => l.state.stage))}` : '';
  console.log(`${sec.toFixed(0).padStart(4)}초${stageNow} 방 ${h.rooms} 사람 ${h.players} 틱 p50 ${l.tickMs.p50} p95 ${l.tickMs.p95} 최대 ${l.tickMs.max} ms · CPU ${l.cpuPercent}% · RSS ${l.rssMb} MB · 보냄 ${(l.bytesOutPerSec / 1024).toFixed(1)} KB/s (1인 ${(l.bytesOutPerPlayerPerSec / 1024).toFixed(2)} KB/s)`);
  if (sec >= WARMUP_SEC) samples.push({ sec, players: h.players, ...l });
}
clearInterval(restarter);
const kills = zombie ? 0 : all.reduce((n, c) => n + c.stats().kills, 0);
const zstats = zombie ? all.map((c) => c.stats()) : [];
await Promise.all(all.map((c) => c.close()));

if (!samples.length) { console.error('표본이 없다(서버에 /healthz가 없거나 측정 시간이 너무 짧다)'); process.exit(1); }
const avg = (k) => samples.reduce((s, x) => s + x[k], 0) / samples.length;
const max = (f) => Math.max(...samples.map(f));
const r2 = (v) => Math.round(v * 100) / 100;
for (const s of samples) s.tickP50 = s.tickMs.p50;
const summary = {
  rooms, botsPerRoom: bots, players: all.length, seconds, samples: samples.length, kills,
  tickP50Ms: r2(avg('tickP50')), tickP95Ms: r2(max((x) => x.tickMs.p95)), tickMaxMs: r2(max((x) => x.tickMs.max)),
  cpuAvgPercent: r2(avg('cpuPercent')), cpuMaxPercent: r2(max((x) => x.cpuPercent)), rssMaxMb: r2(max((x) => x.rssMb)),
  bytesOutPerSecAvg: Math.round(avg('bytesOutPerSec')), bytesPerPlayerPerSecAvg: Math.round(avg('bytesOutPerPlayerPerSec')),
  ...(zombie ? {
    mode: 'zombie', map: values.map, stageMax: Math.max(...zstats.map((x) => x.stage)), bosses: zstats.filter((x, i) => i % bots === 0).reduce((n, x) => n + (x.counts.bossSpawn || 0), 0),
    clientBytesPerSecAvg: Math.round(zstats.reduce((n, x) => n + x.bytesPerSec, 0) / zstats.length), snapMax: Math.max(...zstats.map((x) => x.snapMax))
  } : {})
};
console.log(`요약: 틱 p50 ${summary.tickP50Ms} ms(평균) · p95 ${summary.tickP95Ms} ms(가장 나쁜 30초) · 최대 ${summary.tickMaxMs} ms · CPU 평균 ${summary.cpuAvgPercent}% 최대 ${summary.cpuMaxPercent}% · RSS 최대 ${summary.rssMaxMb} MB · 보냄 ${(summary.bytesOutPerSecAvg / 1024).toFixed(1)} KB/s · 1인 ${(summary.bytesPerPlayerPerSecAvg / 1024).toFixed(2)} KB/s ${zombie ? ` · 도달 스테이지 ${summary.stageMax} · 보스 ${summary.bosses} · 손님이 받은 양 ${(summary.clientBytesPerSecAvg / 1024).toFixed(2)} KB/s` : ` · 킬 ${kills}`}`);
if (values.json) console.log(JSON.stringify(summary));
process.exit(0);
