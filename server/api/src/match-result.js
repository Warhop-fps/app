/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서명한 경기 결과 받기(POST /v1/match-result). 게임 서버(EC2)만 부른다(서버끼리, 브라우저 Origin이 있으면 403).
 *          GAME_RESULT_SECRET(+ GAME_RESULT_SECRET_PREV)으로 서명·kid·시간 창·모양을 검사한 뒤 fps_api_apply_match_result(0003)를 부른다.
 *          비밀 값이 없으면 주소 자체가 없는 것처럼 404. 약속은 docs/MATCH_RESULT_CONTRACT.md, 서명 모듈은 result-sign.js.
 */
import { isDbFault } from './db.js';
import { json, readJson } from './http.js';
import { secretReady, verifyEnvelope } from './result-sign.js';

export const RESULT_BODY_LIMIT = 16384;

/** 검증에 쓸 비밀 값들: [지금 값, 이전 값] 중 32글자 이상인 것. 지금 값이 없으면 빈 목록(주소를 닫는다) */
export function resultSecrets(env) {
  const cur = String(env.GAME_RESULT_SECRET || '').trim();
  if (!secretReady(cur)) return [];
  const prev = String(env.GAME_RESULT_SECRET_PREV || '').trim();
  return secretReady(prev) && prev !== cur ? [cur, prev] : [cur];
}

const STATUS = Object.freeze({ BAD_REQUEST: 400, RESULT_INVALID: 400, UNKNOWN_KID: 401, BAD_SIGNATURE: 401, RESULT_STALE: 401, RESULT_CONFLICT: 409 });

/** POST /v1/match-result: { kid, sig, result } → { ok, duplicate, applied?, skipped?, points? } | { ok:false, error } */
export async function receive(request, ctx) {
  const secrets = resultSecrets(ctx.env);
  const body = await readJson(request, RESULT_BODY_LIMIT);
  if (!body) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  const v = await verifyEnvelope(body, secrets, ctx.now());
  if (!v.ok) {
    ctx.log({ t: 'match_result_reject', error: v.error, problem: v.problem });
    return json(v.problem ? { ok: false, error: v.error, problem: v.problem } : { ok: false, error: v.error }, STATUS[v.error] || 400);
  }
  const r = await ctx.db.call('fps_api_apply_match_result', { p_result: v.result });
  if (isDbFault(r)) return json(r, 503);
  if (r.ok === false) return json(r, STATUS[r.error] || 400);
  ctx.log({ t: 'match_result', id: v.result.resultId, kid: v.kid, duplicate: !!r.duplicate, applied: r.applied, skipped: r.skipped });
  return json(r, 200);
}
