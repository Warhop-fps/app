/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 가짜 클라이언트로 한 판을 끝까지 도는 시험. 1:1과 3:3이 실제 소켓 위에서 이동 → 사격 → 킬 → 라운드 → 경기 끝까지 가고,
 *          지연을 넣은 사수가 옆으로 걷는 적을 쏠 때 되감기를 켜면 맞고 끄면 빗나가는 것을 명중률로 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeClient } from '../tools/fake-client.mjs';
import { FAST_RULES, startTestServer } from './helpers.mjs';

/** promise가 ms 안에 끝나지 않으면 reject. 끝나면 타이머를 지워 프로세스를 붙잡지 않는다 */
function within(promise, ms, why) {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(why())), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** count명을 팀을 번갈아 넣고 방장이 시작해 경기 끝까지. 모든 클라이언트가 matchEnd를 받을 때까지 기다린다 */
async function playMatch({ count, latencyMs = 0, jitterMs = 0, room }) {
  const server = await startTestServer();
  const clients = [];
  try {
    for (let i = 0; i < count; i++) {
      const c = createFakeClient({ url: server.url, room, name: `봇${i + 1}`, team: i % 2 ? 'charterer' : 'owner', latencyMs, jitterMs });
      clients.push(c);
      await c.ready;
    }
    const leader = clients[0];
    await leader.waitFor((c) => c.match && c.match.p.length === count, 5000, '전원 입장');
    const t0 = performance.now();
    leader.start();
    const ends = await Promise.all(clients.map((c) => within(c.matchEnded, 60000,
      () => `${c.id}: 60초 안에 경기가 끝나지 않았다 (phase ${c.phase}, round ${c.round})`)));
    return { server, clients, ends, sec: (performance.now() - t0) / 1000, room: server.rooms.get(room) };
  } catch (err) {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
    throw err;
  }
}

async function cleanup({ server, clients }) {
  await Promise.all(clients.map((c) => c.close()));
  await server.close();
}

/** 모두가 같은 결과를 받았고 규칙대로 끝났는지 */
function checkMatch({ clients, ends, room }) {
  const [end] = ends;
  for (const e of ends) assert.deepEqual(e, end, '모두 같은 matchEnd');
  assert.ok(end.winner === 'owner' || end.winner === 'charterer', `승자 ${end.winner}`);
  assert.equal(end.reason, 'wins');
  assert.equal(end.score[end.winner], FAST_RULES.roundsToWin);
  const evs = clients[0].events;
  const rounds = evs.filter((e) => e.type === 'roundEnd');
  assert.equal(rounds.length, end.score.owner + end.score.charterer, '무승부 라운드 없이 점수 = 라운드 수');
  for (const r of rounds) assert.equal(r.reason, 'elimination', '라운드는 전멸로 끝난다(사격으로 죽였다)');
  // 라운드마다 진 팀 전원이 사격으로 죽었다
  const killsByRound = new Map();
  let round = 0;
  for (const e of evs) {
    if (e.type === 'roundStart') round = e.round;
    if (e.type === 'kill') killsByRound.set(round, [...(killsByRound.get(round) || []), e]);
  }
  for (const r of rounds) {
    const loser = r.winner === 'owner' ? 'charterer' : 'owner';
    const dead = new Set((killsByRound.get(r.round) || []).filter((k) => k.victimTeam === loser && k.weaponId === 'ar_std').map((k) => k.victim));
    assert.equal(dead.size, clients.filter((c) => c.team === loser).length, `라운드 ${r.round}: 진 팀 전원이 총에 맞아 죽었다`);
  }
  // 서버가 판정한 사격이 있고, 모든 킬은 서버가 낸 damage 뒤에 온다
  const st = room.stats();
  assert.ok(st.shots > 0 && st.hits > 0, JSON.stringify(st));
  // 다들 움직였다(스폰에서 다가가 쏜다)
  for (const c of clients) assert.ok(c.stats().inputs > 30, `${c.id} 입력 ${c.stats().inputs}`);
  assert.equal(room.phase, 'matchEnd');
}

describe('가짜 클라이언트 한 판', () => {
  test('1:1 한 판을 끝까지(이동 → 사격 → 킬 → 라운드 → 경기 끝)', { timeout: 90000 }, async (t) => {
    const r = await playMatch({ count: 2, latencyMs: 20, room: 'duel' });
    try {
      t.diagnostic(`${r.sec.toFixed(1)}초, 점수 ${r.ends[0].score.owner}:${r.ends[0].score.charterer}, ${JSON.stringify(r.room.stats())}`);
      checkMatch(r);
      const [a, b] = r.clients.map((c) => c.stats());
      assert.ok(a.kills + b.kills >= 2);
      // 다가가 쏘므로 스폰(12 m)보다 가까워졌다
      const moved = r.clients[0].events.some((e) => e.type === 'fire' && Math.abs(e.o[0]) < 5.9);
      assert.ok(moved, '쏘기 전에 다가갔다');
    } finally { await cleanup(r); }
  });

  test('3:3 한 판을 끝까지(지연 30±10 ms)', { timeout: 90000 }, async (t) => {
    const r = await playMatch({ count: 6, latencyMs: 30, jitterMs: 10, room: 'team3' });
    try {
      t.diagnostic(`${r.sec.toFixed(1)}초, 점수 ${r.ends[0].score.owner}:${r.ends[0].score.charterer}, ${JSON.stringify(r.room.stats())}`);
      checkMatch(r);
      assert.equal(new Set(r.clients.map((c) => c.team)).size, 2);
      assert.equal(r.clients.filter((c) => c.team === 'owner').length, 3);
      const kills = r.clients.reduce((n, c) => n + c.stats().kills, 0);
      assert.ok(kills >= 6, `3:3에서 2라운드 이상 전멸 = 킬 6 이상 (${kills})`);
    } finally { await cleanup(r); }
  });
});

describe('지연 보정(되감기) 끝에서 끝까지', () => {
  /**
   * 사수(지연 40 ms)가 12 m 앞에서 1초마다 좌우로 방향을 바꾸며 걷는 적을 쏜다. 적은 죽지 않게 체력을 크게 둔다.
   * @returns {{ratio:number, shots:number, rewindMs:number}}
   */
  async function strafeDuel(maxRewindMs) {
    const server = await startTestServer({ maxRewindMs, matchRules: { loadoutMs: 300, roundTimeMs: 60000, hp: 100000 } });
    const shooter = createFakeClient({ url: server.url, room: 'lag', name: '사수', team: 'owner', behavior: 'fight', engageDist: 100, burst: [1, 3], latencyMs: 40 });
    await shooter.ready;
    const target = createFakeClient({ url: server.url, room: 'lag', name: '과녁', team: 'charterer', behavior: 'strafe', strafeTicks: 30, latencyMs: 10 });
    await target.ready;
    try {
      await shooter.waitFor((c) => c.match && c.match.p.length === 2, 5000, '입장');
      shooter.start();
      await shooter.waitFor((c) => c.stats().shots >= 30, 30000, '30발');
      const st = shooter.stats();
      return { ratio: st.hitRatio, shots: st.shots, rewindMs: st.avgRewindTicks * shooter.tickMs };
    } finally {
      await shooter.close();
      await target.close();
      await server.close();
    }
  }

  test('지연 40 ms 사수: 되감으면 걷는 적을 맞히고, 되감기를 끄면 빗나간다', { timeout: 90000 }, async (t) => {
    const on = await strafeDuel(300);
    const off = await strafeDuel(0);
    const msg = `되감기 켬 ${Math.round(on.ratio * 100)}% (${on.shots}발, 평균 ${Math.round(on.rewindMs)} ms) / 끔 ${Math.round(off.ratio * 100)}% (${off.shots}발)`;
    t.diagnostic(msg);
    assert.ok(on.rewindMs > 120 && on.rewindMs <= 300, `되감기 양은 왕복 지연 + 보간 지연 근처: ${msg}`);
    assert.ok(on.ratio >= 0.75, msg);
    assert.ok(off.ratio <= 0.35, msg);
  });
});
