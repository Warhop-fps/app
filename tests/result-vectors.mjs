/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 결과 서명 시험 벡터(공용). tests/result-sign.test.mjs와 tests/api-match-result.test.mjs가 함께 쓴다.
 *          docs/MATCH_RESULT_CONTRACT.md 6절과 같은 값이다(바꾸면 둘 다 바꾼다). 게임 서버 쪽 시험도 이 값으로 같은 서명이 나오는지 볼 수 있다.
 */

export const VEC_SECRET = 'test-secret-0123456789abcdef-0123456789';
export const VEC_KID = 'k3838131de372e21d';
export const VEC_SIG = 'ycL25j3JSKtERRFj5Y2tGghVKqSiYtYwUOmOFEitE0M';

export const vecResult = () => ({
  protocol: 1, resultId: 'room-A1:3', roomId: 'room-A1', matchSeq: 3, serverId: 'ec2-a:1', mode: 'ffa', map: 'cqb',
  startedAt: 1795000000000, endedAt: 1795000600000, signedAt: 1795000601000,
  players: [
    { tokenHash: 'a'.repeat(64), kills: 12, deaths: 3, placement: 1, points: 170 },
    { tokenHash: 'b'.repeat(64), kills: 4, deaths: 9, placement: 2, points: 40 }
  ]
});
