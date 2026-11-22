/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 결과 서명 모듈(server/api/src/result-sign.js)을 시험한다. 고정 시험 벡터(문서 docs/MATCH_RESULT_CONTRACT.md와 같은 값),
 *          node:crypto로 따로 계산한 값과의 대조, 정규 직렬화, 모양 검사, kid·이전 열쇠, 시간 창, 바꾼 본문 거절.
 *          이 모듈은 Node 전용 API 없이 쓰여야 한다(Worker와 게임 서버가 함께 import).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MAX_PLAYERS, MAX_POINTS, SIG_SCOPE, WINDOW_MS, canonicalize, keyId, resultProblem, signResult, signingText, verifyEnvelope
} from '../server/api/src/result-sign.js';
import { VEC_KID, VEC_SECRET, VEC_SIG, vecResult } from './result-vectors.mjs';

const VEC_TEXT = SIG_SCOPE + '{"endedAt":1795000600000,"map":"cqb","matchSeq":3,"mode":"ffa","players":['
  + '{"deaths":3,"kills":12,"placement":1,"points":170,"tokenHash":"' + 'a'.repeat(64) + '"},'
  + '{"deaths":9,"kills":4,"placement":2,"points":40,"tokenHash":"' + 'b'.repeat(64) + '"}],'
  + '"protocol":1,"resultId":"room-A1:3","roomId":"room-A1","serverId":"ec2-a:1","signedAt":1795000601000,"startedAt":1795000000000}';
const NOW = 1795000601000;

describe('시험 벡터', () => {
  test('정규 글자·kid·서명이 고정 값과 같다', async () => {
    assert.equal(signingText(vecResult()), VEC_TEXT);
    assert.equal(await keyId(VEC_SECRET), VEC_KID);
    const env = await signResult(vecResult(), VEC_SECRET);
    assert.deepEqual(Object.keys(env), ['kid', 'sig', 'result']);
    assert.equal(env.kid, VEC_KID);
    assert.equal(env.sig, VEC_SIG);
  });

  test('node:crypto로 따로 계산해도 같다(WebCrypto 구현과 독립 대조)', () => {
    const kid = 'k' + createHash('sha256').update('skala-result-kid.v1.' + VEC_SECRET).digest('hex').slice(0, 16);
    assert.equal(kid, VEC_KID);
    const sig = createHmac('sha256', VEC_SECRET).update(VEC_TEXT).digest('base64url');
    assert.equal(sig, VEC_SIG);
  });

  test('문서에 적힌 벡터가 이 값과 같다', () => {
    const doc = readFileSync(new URL('../docs/MATCH_RESULT_CONTRACT.md', import.meta.url), 'utf8');
    for (const v of [VEC_SECRET, VEC_KID, VEC_SIG]) assert.ok(doc.includes(v), v);
  });

  test('모듈은 Node 전용 API·다른 파일을 쓰지 않는다', () => {
    const src = readFileSync(new URL('../server/api/src/result-sign.js', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\b/m.test(src), 'import 없음');
    assert.ok(!/\brequire\(|node:|Buffer\b|process\./.test(src));
  });
});

describe('정규 직렬화', () => {
  test('열쇠 순서와 상관없이 같은 글자, 빈칸 없음', () => {
    assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
    assert.equal(canonicalize({ a: { d: 1, c: 2 } }), canonicalize(JSON.parse('{ "a" : { "c" : 2, "d" : 1 } }')));
    assert.equal(canonicalize('한글"\n'), JSON.stringify('한글"\n'));
  });

  test('소수·NaN·undefined·큰 수·특수 객체는 적지 않는다', () => {
    for (const bad of [1.5, NaN, Infinity, 2 ** 53, undefined, () => 1, new Date(0), { a: undefined }, [1.1]]) {
      assert.throws(() => canonicalize(bad), TypeError);
    }
  });
});

describe('모양 검사', () => {
  test('벡터는 통과한다', () => assert.equal(resultProblem(vecResult()), null));

  test('틀린 칸은 이유를 돌려준다', () => {
    const cases = [
      [(r) => { r.extra = 1; }, 'keys'],
      [(r) => { delete r.map; }, 'keys'],
      [(r) => { r.protocol = 2; }, 'protocol'],
      [(r) => { r.roomId = 'a b'; }, 'roomId'],
      [(r) => { r.matchSeq = 0; }, 'matchSeq'],
      [(r) => { r.resultId = 'room-A1:4'; }, 'resultId'],
      [(r) => { r.serverId = ''; }, 'serverId'],
      [(r) => { r.mode = 'FFA'; }, 'mode'],
      [(r) => { r.map = '../x'; }, 'map'],
      [(r) => { r.startedAt = 5; }, 'startedAt'],
      [(r) => { r.endedAt = r.startedAt - 1; }, 'endedAt'],
      [(r) => { r.signedAt = r.endedAt - 1; }, 'signedAt'],
      [(r) => { r.players = []; }, 'players'],
      [(r) => { r.players = Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => ({ tokenHash: i.toString(16).padStart(64, '0'), kills: 0, deaths: 0, placement: null, points: 0 })); }, 'players'],
      [(r) => { r.players[0].name = '철수'; }, 'player.keys'],
      [(r) => { r.players[0].tokenHash = 'A'.repeat(64); }, 'player.tokenHash'],
      [(r) => { r.players[1].tokenHash = r.players[0].tokenHash; }, 'player.duplicate'],
      [(r) => { r.players[0].kills = -1; }, 'player.count'],
      [(r) => { r.players[0].placement = 0; }, 'player.placement'],
      [(r) => { r.players[0].points = MAX_POINTS + 1; }, 'player.points'],
      [(r) => { r.players[0].points = -5; }, 'player.points']
    ];
    for (const [edit, want] of cases) {
      const r = vecResult();
      edit(r);
      assert.equal(resultProblem(r), want, want);
    }
  });

  test('placement는 null이어도 된다', () => {
    const r = vecResult();
    r.players[1].placement = null;
    assert.equal(resultProblem(r), null);
  });

  test('모양이 틀리면 서명하지 않는다', async () => {
    const r = vecResult();
    r.players[0].points = 1.5;
    await assert.rejects(() => signResult(r, VEC_SECRET));
    await assert.rejects(() => signResult(vecResult(), 'short'));
  });
});

describe('검증', () => {
  const OTHER = 'other-secret-zyxwvutsrqponmlkjihgfedcba';

  test('맞는 봉투는 통과한다(JSON으로 오가도)', async () => {
    const env = JSON.parse(JSON.stringify(await signResult(vecResult(), VEC_SECRET)));
    const v = await verifyEnvelope(env, [VEC_SECRET], NOW);
    assert.equal(v.ok, true);
    assert.equal(v.kid, VEC_KID);
    assert.equal(v.result.resultId, 'room-A1:3');
  });

  test('이전 열쇠(PREV)로 서명한 것도 받는다. 모르는 열쇠는 UNKNOWN_KID', async () => {
    const env = await signResult(vecResult(), OTHER);
    assert.equal((await verifyEnvelope(env, [VEC_SECRET, OTHER], NOW)).ok, true);
    assert.equal((await verifyEnvelope(env, [VEC_SECRET], NOW)).error, 'UNKNOWN_KID');
    assert.equal((await verifyEnvelope(env, [VEC_SECRET, '', undefined, 'short'], NOW)).error, 'UNKNOWN_KID');
  });

  test('본문을 한 글자라도 바꾸면 BAD_SIGNATURE', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    env.result.players[1].points = 41;
    assert.equal((await verifyEnvelope(env, [VEC_SECRET], NOW)).error, 'BAD_SIGNATURE');
    const env2 = await signResult(vecResult(), VEC_SECRET);
    env2.sig = env2.sig.slice(0, -1) + (env2.sig.endsWith('A') ? 'B' : 'A');
    assert.equal((await verifyEnvelope(env2, [VEC_SECRET], NOW)).error, 'BAD_SIGNATURE');
    env2.sig = 'not-a-sig';
    assert.equal((await verifyEnvelope(env2, [VEC_SECRET], NOW)).error, 'BAD_SIGNATURE');
  });

  test('다른 kid를 적어 다른 열쇠로 검증시키려 해도 막힌다', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    env.kid = await keyId(OTHER);
    assert.equal((await verifyEnvelope(env, [VEC_SECRET, OTHER], NOW)).error, 'BAD_SIGNATURE');
  });

  test('시간 창(10분)을 넘으면 RESULT_STALE', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    assert.equal((await verifyEnvelope(env, [VEC_SECRET], NOW + WINDOW_MS)).ok, true);
    assert.equal((await verifyEnvelope(env, [VEC_SECRET], NOW + WINDOW_MS + 1)).error, 'RESULT_STALE');
    assert.equal((await verifyEnvelope(env, [VEC_SECRET], NOW - WINDOW_MS - 1)).error, 'RESULT_STALE');
  });

  test('봉투 모양이 틀리면 BAD_REQUEST, 서명은 맞지만 모양이 틀린 결과는 RESULT_INVALID', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    assert.equal((await verifyEnvelope(null, [VEC_SECRET], NOW)).error, 'BAD_REQUEST');
    assert.equal((await verifyEnvelope({ ...env, extra: 1 }, [VEC_SECRET], NOW)).error, 'BAD_REQUEST');
    assert.equal((await verifyEnvelope({ ...env, kid: 'K1' }, [VEC_SECRET], NOW)).error, 'BAD_REQUEST');
    // 열쇠를 가진 쪽이 모양 검사 없이 서명한 경우(직접 HMAC)
    const r = vecResult();
    r.players[0].points = MAX_POINTS + 1;
    const sig = createHmac('sha256', VEC_SECRET).update(signingText(r)).digest('base64url');
    const v = await verifyEnvelope({ kid: VEC_KID, sig, result: r }, [VEC_SECRET], NOW);
    assert.equal(v.error, 'RESULT_INVALID');
    assert.equal(v.problem, 'player.points');
    const f = { kid: VEC_KID, sig, result: { ...r, matchSeq: 1.5 } };
    assert.equal((await verifyEnvelope(f, [VEC_SECRET], NOW)).error, 'RESULT_INVALID');
  });
});
