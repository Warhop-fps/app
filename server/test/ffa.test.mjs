/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버가 판정하는 개인전을 실제 소켓 위에서 끝까지 도는 시험. 가짜 클라이언트 넷이 목표 킬 5인 방에서 싸우고, 죽으면 즉시 부활(respawn)을 청하고,
 *          경기 끝에 각자 자기 보상(reward)만 받는 것을 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MATCH_POINTS } from '../../js/account/economy.js';
import { createFakeClient } from '../tools/fake-client.js';
import { startTestServer, until } from './helpers.mjs';

function within(promise, ms, why) {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(why())), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

describe('개인전 한 판(소켓)', () => {
  test('넷이 5킬 방에서 끝까지: 우승자 한 명, 즉시 부활, 사람마다 자기 보상', { timeout: 120000 }, async (t) => {
    // 부활 3초(기본)라 즉시 부활이 늘 받아들여진다. 무적은 꺼서 빨리 끝낸다
    const server = await startTestServer({ matchRules: { loadoutMs: 300, spawnProtectMs: 0, timeLimitMs: 90000 } });
    const clients = [];
    try {
      for (let i = 0; i < 4; i++) {
        const c = createFakeClient({
          url: server.url, room: 'ffa4', name: `봇${i + 1}`, behavior: 'fight', latencyMs: 20, jitterMs: 5,
          opts: { mode: 'ffa', killTarget: 5 }, quickRespawn: i < 2
        });
        clients.push(c);
        await c.ready;
      }
      assert.equal(clients[0].killTarget, 5);
      assert.equal(clients[3].killTarget, 5, '나중에 온 사람의 opts는 방을 바꾸지 않는다');
      const leader = clients[0];
      await leader.waitFor((c) => c.match && c.match.p.length === 4, 5000, '전원 입장');
      leader.start();
      const ends = await Promise.all(clients.map((c) => within(c.matchEnded, 100000, () => `${c.id}: 경기가 끝나지 않았다 (phase ${c.phase})`)));
      const end = ends[0];
      t.diagnostic(`끝: ${end.reason}, 우승 ${end.winner}, ${JSON.stringify(server.rooms.get('ffa4').stats())}`);
      assert.equal(end.mode, 'ffa');
      for (const e of ends) assert.equal(e.winner, end.winner, '모두 같은 결과');
      assert.equal(end.reason, 'kills');
      const top = end.ranking[0];
      assert.equal(top.id, end.winner);
      assert.ok(top.kills >= 5);
      await until(() => clients.every((c) => c.reward), 3000, '보상');
      for (const c of clients) {
        assert.equal(c.reward.id, c.id, '자기 보상만 받는다');
        assert.equal(c.reward.summary.killTarget, 5);
        assert.equal(c.reward.summary.win, c.id === end.winner);
        assert.equal(c.reward.quick, c.quick, '서버가 센 즉시 부활 = 내가 받은 instant spawn');
      }
      const winner = clients.find((c) => c.id === end.winner);
      const m = MATCH_POINTS.multi;
      const s = winner.reward.summary;
      assert.equal(winner.reward.reward.gained, s.kills * m.kill + s.headshots * m.headshot + Math.round((m.win * 5) / 20) + m.finish - winner.reward.cost);
      const quickTotal = clients.reduce((n, c) => n + c.quick, 0);
      assert.ok(quickTotal >= 1, `즉시 부활이 한 번 이상 (${quickTotal})`);
      assert.equal(clients[2].quick + clients[3].quick, 0, '청하지 않은 사람은 즉시 부활이 없다');
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await server.close();
    }
  });
});
