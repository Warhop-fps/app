/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버의 경기 결과 만들기(server/core/rewards.js buildResult)와 join의 토큰 해시 검사(protocol.decodeClient) 시험. 소켓 없이 돈다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildResult } from '../server/core/rewards.js';
import { decodeClient } from '../server/core/protocol.js';
import { resultProblem } from '../server/api/src/result-sign.js';

const H = (c) => c.repeat(64);
const rw = (id, kills, deaths, gained) => ({ id, summary: { kills, deaths }, reward: { gained } });

describe('경기 결과 만들기', () => {
  const ev = { type: 'matchEnd', mode: 'ffa', ranking: [{ rank: 1, id: 'p1' }, { rank: 2, id: 'p2' }, { rank: 2, id: 'p3' }, { rank: 4, id: 'p4' }] };
  const base = { roomId: 'abc-0a1b2c3d-1', matchSeq: 2, serverId: 'ec2-a:1', map: 'arena', startedAt: 1795000000000, endedAt: 1795000300000 };

  test('토큰 해시가 있는 사람만, 포인트는 0~2000으로 자르고, 순위는 공동 등수 그대로', () => {
    const hashes = new Map([['p1', H('a')], ['p2', H('b')], ['p4', H('d')]]);
    const r = buildResult(ev, [rw('p1', 5, 1, 2500), rw('p2', 3, 4, 50), rw('p3', 2, 2, 40), rw('p4', 0, 6, -10)], { ...base, hashes });
    assert.equal(resultProblem({ ...r, signedAt: base.endedAt + 1 }), null, '약속 모양 검사를 통과한다');
    assert.equal(r.resultId, 'abc-0a1b2c3d-1:2');
    assert.equal(r.mode, 'ffa');
    assert.deepEqual(r.players.map((p) => [p.tokenHash[0], p.points, p.placement]), [['a', 2000, 1], ['b', 50, 2], ['d', 0, 4]]);
    assert.equal(r.signedAt, undefined, 'signedAt은 보내는 쪽이 채운다');
  });

  test('같은 해시로 두 번 들어온 사람은 한 번만, 넣을 사람이 없으면 null', () => {
    const r = buildResult(ev, [rw('p1', 1, 0, 30), rw('p2', 9, 0, 90)], { ...base, hashes: new Map([['p1', H('a')], ['p2', H('a')]]) });
    assert.equal(r.players.length, 1);
    assert.equal(buildResult(ev, [rw('p1', 1, 0, 30)], { ...base, hashes: new Map() }), null);
  });

  test('시작 시각이 없으면(라이브 전 끝) 끝 시각으로', () => {
    const r = buildResult(ev, [rw('p1', 0, 0, 20)], { ...base, startedAt: null, hashes: new Map([['p1', H('a')]]) });
    assert.equal(r.startedAt, r.endedAt);
  });
});

describe('join의 토큰 해시', () => {
  const join = (tokenHash) => decodeClient(JSON.stringify({ t: 'join', v: 2, name: 'a', tokenHash })).msg;
  test('소문자 hex 64자만 받고, 아니면 null(손님)', () => {
    assert.equal(join(H('f')).tokenHash, H('f'));
    assert.equal(join(H('F')).tokenHash, null);
    assert.equal(join('abc').tokenHash, null);
    assert.equal(join(undefined).tokenHash, null);
    assert.equal(join(123).tokenHash, null);
  });
});
