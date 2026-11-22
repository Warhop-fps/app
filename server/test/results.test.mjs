/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 결과 보내기 시험. 우체부(node/results.js)의 다시 보내기 규칙을 가짜 API로 보고, 실제 소켓 위에서 개인전 한 판이 끝나면
 *          서버가 약속 모양의 결과를 서명해 보내는지(검증 함수로 확인), 토큰 해시가 다른 사람에게 새지 않는지 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyEnvelope } from '../api/src/result-sign.js';
import { createResultPoster, RETRY_DELAYS_MS } from '../node/results.js';
import { createLogger, memoryStream } from '../node/log.js';
import { createFakeClient } from '../tools/fake-client.js';
import { startTestServer, until } from './helpers.mjs';

const SECRET = 'test-secret-0123456789abcdef-0123456789';
const URL_ = 'https://api.test/v1/match-result';
const H = (c) => c.repeat(64);

function memLog() {
  const stream = memoryStream();
  return { log: createLogger({ level: 'info', stream }), stream };
}
function sampleResult(over = {}) {
  return {
    protocol: 1, resultId: 'abc-0001-1:1', roomId: 'abc-0001-1', matchSeq: 1, serverId: 'local', mode: 'ffa', map: 'arena',
    startedAt: 1795000000000, endedAt: 1795000300000,
    players: [{ tokenHash: H('a'), kills: 5, deaths: 1, placement: 1, points: 115 }],
    ...over
  };
}
/** 답을 차례로 돌려주는 가짜 fetch. 받은 본문을 모은다 */
function scripted(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r === 'network') throw new TypeError('fetch failed');
    return { status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const OK = { status: 200, body: { ok: true, duplicate: false, applied: 1, skipped: 0, points: [] } };

describe('경기 결과 우체부', () => {
  test('비밀 값이나 주소가 없으면 꺼지고 한 줄 남긴다', () => {
    const { log, stream } = memLog();
    const p = createResultPoster({ url: URL_, secret: 'short', log, fetch: scripted([OK]) });
    assert.equal(p.enabled, false);
    assert.equal(p.post(sampleResult()), false);
    assert.ok(stream.lines().some((l) => l.msg === 'match results disabled'));
    assert.equal(createResultPoster({ url: '', secret: SECRET, log }).enabled, false);
  });

  test('서명한 봉투를 보내고 200이면 끝(서명은 Worker 검증 함수로 통과)', async () => {
    const { log, stream } = memLog();
    const f = scripted([OK]);
    const now = 1795000400000;
    const p = createResultPoster({ url: URL_, secret: SECRET, log, fetch: f, now: () => now });
    assert.equal(p.post(sampleResult()), true);
    await p.idle();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.headers.origin, undefined, 'Origin을 싣지 않는다');
    const v = await verifyEnvelope(f.calls[0].body, [SECRET], now);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.result.signedAt, now);
    assert.equal(p.stats().posted, 1);
    assert.ok(stream.lines().some((l) => l.msg === 'match result posted' && l.resultId === 'abc-0001-1:1'));
  });

  test('503·404·네트워크 오류는 같은 resultId로 다시, 보낼 때마다 다시 서명', async () => {
    const { log } = memLog();
    let t = 1795000400000;
    const f = scripted([{ status: 503, body: { ok: false, error: 'DB_DOWN' } }, 'network', { status: 404, body: { ok: false, error: 'not_found' } }, OK]);
    const p = createResultPoster({ url: URL_, secret: SECRET, log, fetch: f, now: () => (t += 1000), delays: [5, 5, 5] });
    p.post(sampleResult());
    await p.idle();
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every((c) => c.body.result.resultId === 'abc-0001-1:1'));
    const signed = f.calls.map((c) => c.body.result.signedAt);
    assert.equal(new Set(signed).size, 4, 'signedAt이 매번 새 값');
    assert.equal(p.stats().retried, 3);
    assert.equal(p.stats().posted, 1);
  });

  test('RESULT_STALE이면 바로 다시 서명해 한 번 더, 400·409·BAD_SIGNATURE는 다시 보내지 않는다', async () => {
    const { log, stream } = memLog();
    const f = scripted([{ status: 401, body: { ok: false, error: 'RESULT_STALE' } }, OK]);
    const p = createResultPoster({ url: URL_, secret: SECRET, log, fetch: f, delays: [5] });
    p.post(sampleResult());
    await p.idle();
    assert.equal(f.calls.length, 2);
    assert.equal(p.stats().posted, 1);
    for (const bad of [{ status: 400, body: { ok: false, error: 'RESULT_INVALID', problem: 'players' } }, { status: 409, body: { ok: false, error: 'RESULT_CONFLICT' } }, { status: 401, body: { ok: false, error: 'BAD_SIGNATURE' } }]) {
      const g = scripted([bad, OK]);
      const q = createResultPoster({ url: URL_, secret: SECRET, log, fetch: g, delays: [5] });
      q.post(sampleResult());
      await q.idle();
      assert.equal(g.calls.length, 1, `${bad.status} ${bad.body.error}: 한 번만`);
      assert.equal(q.stats().failed, 1);
    }
    assert.ok(stream.lines().some((l) => l.msg === 'match result rejected' && l.error === 'RESULT_CONFLICT'));
  });

  test('횟수 상한에서 포기하고, 끌 때 남은 결과는 로그만 남긴다', async () => {
    const { log, stream } = memLog();
    const f = scripted(['network']);
    const p = createResultPoster({ url: URL_, secret: SECRET, log, fetch: f, delays: [2], maxAttempts: 3 });
    p.post(sampleResult());
    await p.idle();
    assert.equal(f.calls.length, 3);
    assert.ok(stream.lines().some((l) => l.msg === 'match result gave up'));
    const slow = createResultPoster({ url: URL_, secret: SECRET, log, fetch: scripted(['network']), delays: [60000] });
    slow.post(sampleResult({ resultId: 'x-1:1', roomId: 'x-1' }));
    await until(() => slow.stats().retried === 1, 2000, '첫 실패');
    slow.close();
    assert.equal(slow.pending, 0);
    assert.ok(stream.lines().some((l) => l.msg === 'match result dropped on shutdown' && l.resultId === 'x-1:1'));
  });

  test('기본 간격은 약속 4절과 같다(1초, 5초, 30초, 2분, 10분)', () => {
    assert.deepEqual([...RETRY_DELAYS_MS], [1000, 5000, 30000, 120000, 600000]);
  });
});

describe('개인전 결과(소켓)', () => {
  test('둘이 5킬 방을 끝까지: 서버가 결과를 서명해 보내고, 손님은 빠지고, 해시는 남에게 가지 않는다', { timeout: 120000 }, async () => {
    const posted = [];
    const fakeApi = async (url, init) => {
      const env = JSON.parse(init.body);
      const v = await verifyEnvelope(env, [SECRET], Date.now());
      posted.push({ url, v, env });
      return { status: v.ok ? 200 : 401, json: async () => (v.ok ? { ok: true, duplicate: false, applied: env.result.players.length, skipped: 0 } : { ok: false, error: v.error }) };
    };
    const server = await startTestServer({
      matchRules: { loadoutMs: 300, spawnProtectMs: 0, timeLimitMs: 90000 },
      resultUrl: URL_, resultSecret: SECRET, serverId: 'test:1', fetch: fakeApi
    });
    const texts = new Map();
    const clients = [];
    try {
      const hashes = [H('a'), H('b'), null];
      for (let i = 0; i < 3; i++) {
        const mine = [];
        texts.set(i, mine);
        const c = createFakeClient({
          url: server.url, room: 'res1', name: `봇${i + 1}`, behavior: i < 2 ? 'fight' : 'idle', latencyMs: 10,
          opts: { mode: 'ffa', killTarget: 5 }, quickRespawn: true, tokenHash: hashes[i] || undefined, onRaw: (t) => mine.push(t)
        });
        clients.push(c);
        await c.ready;
      }
      await clients[0].waitFor((c) => c.match && c.match.p.length === 3, 5000, '전원 입장');
      clients[0].start();
      await Promise.all(clients.map((c) => c.matchEnded));
      await until(() => posted.length === 1, 5000, '결과 전송');
      await server.results.idle();
      await until(() => clients.every((c) => c.reward), 3000, '보상');
      const { v, url, env } = posted[0];
      assert.equal(url, URL_);
      assert.equal(v.ok, true, JSON.stringify(v));
      const r = env.result;
      assert.equal(r.mode, 'ffa');
      assert.equal(r.serverId, 'test:1');
      assert.match(r.roomId, /^res1-[0-9a-f]{8}-\d+$/);
      assert.equal(r.resultId, `${r.roomId}:1`);
      assert.equal(r.players.length, 2, '토큰 해시가 없는 손님은 빠진다');
      for (const [i, h] of [[0, H('a')], [1, H('b')]]) {
        const row = r.players.find((p) => p.tokenHash === h);
        const rw = clients[i].reward;
        assert.ok(row && rw, `봇${i + 1}`);
        assert.equal(row.kills, rw.summary.kills);
        assert.equal(row.deaths, rw.summary.deaths);
        assert.equal(row.points, Math.max(0, Math.min(2000, rw.reward.gained)), '포인트 = 서버 보상(즉시 부활 값을 뺀 값)');
        assert.equal(rw.server, true, '보상 이벤트가 서버가 넣는다고 알린다');
        assert.ok(Number.isInteger(row.placement) && row.placement >= 1);
      }
      assert.equal(clients[2].reward.server, false, '손님은 서버가 넣지 않는다');
      for (const [i, mine] of texts) {
        for (const h of [H('a'), H('b')]) {
          const own = (i === 0 && h === H('a')) || (i === 1 && h === H('b'));
          assert.ok(!mine.some((t) => t.includes(h)), `봇${i + 1}이 받은 메시지에 ${own ? '자기' : '남의'} 해시가 없다`);
        }
      }
      assert.equal(server.stats().results.posted, 1);
    } finally {
      for (const c of clients) c.close();
      await server.close();
    }
  });
});
