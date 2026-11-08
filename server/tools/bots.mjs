/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 떠 있는 권위 서버에 가짜 클라이언트 여러 명을 붙여 한 판을 끝까지 돌리는 명령. 팀을 번갈아 나누고, 방장이 시작한 뒤
 *          경기 끝 이벤트까지 기다려 점수·킬·명중률·평균 되감기를 출력한다. 시간 안에 끝나지 않으면 종료 코드 1.
 */
/**
 *   npm run server                                    # 다른 창에서 서버
 *   npm run server:bots -- --bots 6 --latency 40      # 3:3, 한쪽 지연 40 ms
 *   node server/tools/bots.mjs --url ws://127.0.0.1:8787/ws --room demo --bots 4 --timeout 180
 */
import { parseArgs } from 'node:util';
import { createFakeClient } from './fake-client.mjs';

const USAGE = `사용법: node server/tools/bots.mjs [옵션]
  --url <ws://…/ws>   서버 주소 (기본 ws://127.0.0.1:8787/ws)
  --room <id>         방 이름 (기본 bots-<시각>)
  --bots <n>          가짜 클라이언트 수 2~6 (기본 4)
  --latency <ms>      한쪽 지연 (기본 30)     --jitter <ms>  지연 흔들림 (기본 10)
  --map <id>          방을 만들 때 맵 (기본 서버 설정, 가짜 클라이언트는 가림막 없는 arena를 전제로 겨눈다)
  --timeout <s>       이 안에 경기가 끝나야 한다 (기본 180)`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:8787/ws' },
    room: { type: 'string' },
    bots: { type: 'string', default: '4' },
    latency: { type: 'string', default: '30' },
    jitter: { type: 'string', default: '10' },
    map: { type: 'string' },
    timeout: { type: 'string', default: '180' },
    help: { type: 'boolean', short: 'h' }
  }
});
if (values.help) { console.log(USAGE); process.exit(0); }
const count = Number(values.bots);
if (!Number.isInteger(count) || count < 2 || count > 6) fail(`--bots: 2~6 (받은 값 ${values.bots})\n\n${USAGE}`);
const latencyMs = Number(values.latency), jitterMs = Number(values.jitter), timeoutMs = Number(values.timeout) * 1000;
const room = values.room || `bots-${Date.now().toString(36)}`;
const opts = values.map ? { map: values.map } : undefined;

const clients = [];
const started = performance.now();
const timer = setTimeout(async () => {
  console.error(`시간 초과: ${values.timeout}초 안에 경기가 끝나지 않았다`);
  for (const c of clients) console.error(`  ${c.id} phase=${c.phase} round=${c.round} ${JSON.stringify(c.stats())}`);
  await Promise.all(clients.map((c) => c.close()));
  process.exit(1);
}, timeoutMs);

try {
  for (let i = 0; i < count; i++) {
    const c = createFakeClient({
      url: values.url, room, name: `봇${i + 1}`, team: i % 2 === 0 ? 'owner' : 'charterer', opts, behavior: 'fight', latencyMs, jitterMs
    });
    clients.push(c);
    await c.ready;   // 순서대로 들어가야 첫 봇이 방장이 된다
  }
  const leader = clients[0];
  console.log(`방 ${room}: 가짜 클라이언트 ${count}명 입장 (${clients.map((c) => `${c.id}:${c.team}`).join(', ')})`);
  await leader.waitFor((c) => c.match && c.match.p.filter((r) => r[3] & 1).length === count, 10000, '전원 입장');
  leader.start();
  const end = await leader.matchEnded;
  clearTimeout(timer);
  const sec = ((performance.now() - started) / 1000).toFixed(1);
  const view = leader.match;
  console.log(`경기 끝 (${sec}초): 승리 ${end.winner ?? '무승부'} · 이유 ${end.reason} · 점수 ${end.score.owner}:${end.score.charterer} · 라운드 ${view ? view.h.length : '?'}`);
  for (const c of clients) {
    const st = c.stats();
    console.log(`  ${st.id} ${st.team.padEnd(9)} 킬 ${st.kills} 데스 ${st.deaths} 사격 ${st.shots} 명중 ${st.hits} (${Math.round(st.hitRatio * 100)}%) 평균 되감기 ${(st.avgRewindTicks * c.tickMs).toFixed(0)} ms 입력 ${st.inputs}`);
  }
  await Promise.all(clients.map((c) => c.close()));
  process.exit(0);
} catch (err) {
  clearTimeout(timer);
  console.error(`실패: ${err.message}`);
  await Promise.all(clients.map((c) => c.close()));
  process.exit(1);
}
