/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 방마다 판정 엔진 고르기. 방장 브라우저가 개인전을 시작할 때 게임 서버의 GET /rollout(비율·받는지)을 읽고 주사위를 굴려
 *          'server'(게임 서버가 판정) 또는 'host'(지금처럼 방장 브라우저가 판정)를 정한다. 게임 서버 주소가 없거나 닿지 않으면 늘 'host'다.
 */
/**
 *   const eng = await chooseEngine();       // 'server' | 'host'
 *   const why = lastChoice().why;           // 'no_url' | 'forced_host' | 'unreachable' | 'off' | 'dice' | 'forced' | 'picked'
 *
 * 순서
 *   1. SKALA_CONFIG.gameServer.url이 비었으면 'host' (지금 배포 값. 실제 게임은 바뀌지 않는다)
 *   2. 주소에 ?server=0 이면 'host'
 *   3. /rollout을 1.5초 안에 읽는다. 못 읽으면 'host'(서버가 꺼졌거나 막혔다 = 방장 판정으로 대신한다)
 *   4. accepting이 false거나 ratio가 0이면 'host'(운영자의 끄는 스위치, 서버가 가득 참)
 *   5. ?server=1 또는 transport 'server'면 'server'(시험용으로 비율을 1로 본다)
 *   6. random() < ratio 이면 'server', 아니면 'host'
 * 이렇게 고른 뒤에도 접속이 실패하면 세션이 방장 판정으로 대신한다(js/game/session.js).
 */
const TIMEOUT_MS = 1500;
let last = { engine: 'host', why: 'no_url', ratio: 0 };

/** 설정의 게임 서버 주소(ws…)를 http(s) 바탕 주소로. 없거나 형식이 틀리면 '' */
export function gameServerBase(cfg = globalThis.SKALA_CONFIG || {}) {
  const raw = cfg && cfg.gameServer && typeof cfg.gameServer.url === 'string' ? cfg.gameServer.url.trim() : '';
  if (!raw) return '';
  const url = raw.replace(/^ws/, 'http').replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/.test(url) ? url : '';
}

/** 그 바탕 주소의 ws 주소(connectGameServer에 준다) */
export function gameServerWs(base) {
  return base ? base.replace(/^http/, 'ws') : '';
}

function flag(search) {
  try { return new URLSearchParams(search || '').get('server'); } catch (_) { return null; }
}

/** GET /rollout → { ok, accepting, ratio, protocol } 또는 { ok:false } (던지지 않는다) */
export async function fetchRollout(base, { fetch: f = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!base || typeof f !== 'function') return { ok: false };
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ac) ac.abort(); }, timeoutMs);
  try {
    const res = await Promise.race([
      f(`${base}/rollout`, { cache: 'no-store', signal: ac ? ac.signal : undefined }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs + 50))
    ]);
    if (!res || !res.ok) return { ok: false };
    const v = await res.json();
    if (!v || typeof v !== 'object') return { ok: false };
    const ratio = Number(v.ratio);
    return { ok: true, accepting: v.accepting === true, ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0, protocol: Number(v.protocol) || null };
  } catch (_) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} [o]
 * @param {object} [o.cfg] SKALA_CONFIG
 * @param {string} [o.search] location.search
 * @param {typeof fetch} [o.fetch]
 * @param {() => number} [o.random]
 * @returns {Promise<'server'|'host'>}
 */
export async function chooseEngine(o = {}) {
  const cfg = o.cfg || globalThis.SKALA_CONFIG || {};
  const search = o.search !== undefined ? o.search : (globalThis.location && globalThis.location.search) || '';
  const random = o.random || Math.random;
  const pick = (engine, why, ratio = 0) => { last = { engine, why, ratio }; return engine; };
  const base = gameServerBase(cfg);
  if (!base) return pick('host', 'no_url');
  const f = flag(search);
  if (f === '0') return pick('host', 'forced_host');
  const info = await fetchRollout(base, { fetch: o.fetch });
  if (!info.ok) return pick('host', 'unreachable');
  if (!info.accepting || !(info.ratio > 0)) return pick('host', 'off');
  if (f === '1' || cfg.transport === 'server') return pick('server', 'forced', info.ratio);
  return random() < info.ratio ? pick('server', 'picked', info.ratio) : pick('host', 'dice', info.ratio);
}

/** 마지막으로 고른 값과 이유(진단·추적 기록용) */
export function lastChoice() { return { ...last }; }
