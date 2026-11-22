/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버가 판정한 경기 결과를 서명해 API Worker(POST /v1/match-result)로 보내는 우체부. 약속(docs/MATCH_RESULT_CONTRACT.md 4절)의
 *          다시 보내기 규칙(503·404·네트워크 오류는 1초·5초·30초·2분·10분 간격, 보낼 때마다 signedAt을 새로 채워 다시 서명)을 지키고 결과마다 로그를 남긴다.
 *          비밀 값(GAME_RESULT_SECRET)이나 주소(GAME_RESULT_URL)가 없으면 꺼진 채로 한 줄 로그만 남긴다.
 */
/**
 *   const poster = createResultPoster({ url, secret, log });
 *   poster.enabled                 // 주소와 32글자 이상 비밀 값이 있으면 true
 *   poster.post(result)            // result = room의 onResult 값(signedAt 없음). 바로 돌아오고, 보내기는 뒤에서 한다
 *   await poster.idle()            // 줄이 빌 때까지(시험·종료용)
 *   poster.close()                 // 남은 결과는 로그(result dropped)만 남기고 버린다(서버가 꺼지면 그 경기는 무효)
 *
 * 응답별로 하는 일(약속 4절 표)
 *   200            끝(duplicate:true도 끝)
 *   400·409        다시 보내지 않는다. error 로그(코드 버그이거나 결과 번호가 겹쳤다)
 *   401 STALE      signedAt을 새로 채워 바로 다시(한 번 더 STALE이면 보통 간격)
 *   401 그 밖      비밀 값이 어긋났다. 다시 보내지 않는다. error 로그(운영자가 GAME_RESULT_SECRET을 맞춰야 한다)
 *   403·404·503·네트워크  간격을 두고 같은 resultId로 다시. 같은 번호라 두 번 더해지지 않는다
 */
import { SECRET_MIN, signResult } from '../api/src/result-sign.js';

/** 다시 보내기 간격(ms). 마지막 값으로 maxAttempts까지 이어 간다 */
export const RETRY_DELAYS_MS = Object.freeze([1000, 5000, 30000, 120000, 600000]);
export const DEFAULT_MAX_ATTEMPTS = 12;   // 첫 시도 + 다시 11번(약 1시간 반)
const RETRY_STATUS = new Set([403, 404, 429, 500, 502, 503, 504]);

/**
 * @param {object} o
 * @param {string} [o.url] POST 주소(예: https://skala-api.skala-fps.workers.dev/v1/match-result)
 * @param {string} [o.secret] GAME_RESULT_SECRET(32글자 이상)
 * @param {object} o.log 로거(info·warn·error)
 * @param {typeof fetch} [o.fetch]
 * @param {() => number} [o.now=Date.now]
 * @param {number[]} [o.delays=RETRY_DELAYS_MS]
 * @param {number} [o.maxAttempts=DEFAULT_MAX_ATTEMPTS]
 * @param {number} [o.timeoutMs=10000] 요청 하나의 시간 제한
 */
export function createResultPoster(o) {
  const log = o.log;
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const secret = typeof o.secret === 'string' ? o.secret : '';
  const doFetch = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const delays = o.delays && o.delays.length ? o.delays : RETRY_DELAYS_MS;
  const maxAttempts = o.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = o.timeoutMs || 10000;
  const enabled = !!url && /^https?:\/\//.test(url) && secret.length >= SECRET_MIN && typeof doFetch === 'function';
  const pending = new Map();   // resultId → { result, attempts, timer }
  const counts = { posted: 0, duplicate: 0, retried: 0, failed: 0, dropped: 0 };
  let closed = false;
  let waiters = [];

  if (!enabled) {
    const why = !url ? 'GAME_RESULT_URL 없음' : !/^https?:\/\//.test(url) ? 'GAME_RESULT_URL 형식' : 'GAME_RESULT_SECRET 없음 또는 32글자 미만';
    log.info({ why }, 'match results disabled');   // 경기 결과를 보내지 않는다(포인트가 들어가지 않는다)
  }

  function settle(id) {
    const p = pending.get(id);
    if (p && p.timer) clearTimeout(p.timer);
    pending.delete(id);
    if (!pending.size) { const w = waiters; waiters = []; for (const fn of w) fn(); }
  }

  function retryLater(id, why) {
    const p = pending.get(id);
    if (!p || closed) return;
    if (p.attempts >= maxAttempts) {
      counts.failed++;
      log.error({ resultId: id, attempts: p.attempts, why }, 'match result gave up');
      settle(id);
      return;
    }
    const wait = delays[Math.min(p.attempts - 1, delays.length - 1)];
    counts.retried++;
    log.warn({ resultId: id, attempts: p.attempts, why, retryInMs: wait }, 'match result retry');
    p.timer = setTimeout(() => send(id), wait);
    if (p.timer.unref) p.timer.unref();
  }

  async function send(id, staleRetry = false) {
    const p = pending.get(id);
    if (!p || closed) return;
    p.timer = null;
    p.attempts++;
    let res, body = null;
    try {
      // 보낼 때마다 signedAt을 새로 채워 다시 서명한다(10분 시간 창, RESULT_STALE 대비)
      const envelope = await signResult({ ...p.result, signedAt: Math.max(p.result.endedAt, now()) }, secret);
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
      try {
        res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: ac ? ac.signal : undefined });
        try { body = await res.json(); } catch { body = null; }
      } finally { if (timer) clearTimeout(timer); }
    } catch (err) {
      if (err && /모양이 틀렸습니다/.test(String(err.message))) {
        counts.failed++;
        log.error({ resultId: id, err }, 'match result invalid; not sent');
        settle(id);
        return;
      }
      retryLater(id, 'network');
      return;
    }
    if (closed) return;
    const code = body && typeof body.error === 'string' ? body.error : null;
    if (res.status === 200 && body && body.ok) {
      if (body.duplicate) counts.duplicate++; else counts.posted++;
      log.info({ resultId: id, attempts: p.attempts, duplicate: !!body.duplicate, applied: body.applied, skipped: body.skipped }, 'match result posted');
      settle(id);
      return;
    }
    if (res.status === 401 && code === 'RESULT_STALE' && !staleRetry) { p.attempts--; send(id, true); return; }
    if (RETRY_STATUS.has(res.status) || (res.status === 401 && code === 'RESULT_STALE')) { retryLater(id, `${res.status}${code ? ' ' + code : ''}`); return; }
    counts.failed++;
    log.error({ resultId: id, status: res.status, error: code, problem: body && body.problem }, 'match result rejected');
    settle(id);
  }

  return {
    get enabled() { return enabled; },
    get pending() { return pending.size; },
    stats: () => ({ enabled, pending: pending.size, ...counts }),
    post(result) {
      if (!enabled || closed || !result || typeof result.resultId !== 'string') return false;
      if (pending.has(result.resultId)) return false;
      pending.set(result.resultId, { result, attempts: 0, timer: null });
      log.info({ resultId: result.resultId, players: result.players.length, map: result.map }, 'match result queued');
      send(result.resultId);
      return true;
    },
    idle() { return pending.size ? new Promise((r) => waiters.push(r)) : Promise.resolve(); },
    close() {
      if (closed) return;
      closed = true;
      for (const [id, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        counts.dropped++;
        log.error({ resultId: id, attempts: p.attempts }, 'match result dropped on shutdown');
      }
      pending.clear();
      const w = waiters; waiters = []; for (const fn of w) fn();
    }
  };
}
