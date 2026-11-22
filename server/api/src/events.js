/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 사용 기록 받기(POST /v1/events). 브라우저(js/net/telemetry.js)가 모아 보낸 사건 묶음을 검사해 fps_api_log_events로 넣는다.
 *          개인 정보는 받지 않는다: 이름·이메일·IP·기기 토큰 칸이 없고, 모르는 칸이 있으면 묶음 전체를 거절한다.
 *          한도: 한 묶음 20개·16 KB, 같은 IP는 이 Worker 인스턴스에서 1분에 240개(메모리에서만 세고 저장하지 않는다),
 *          같은 anon_id는 DB에서 한 시간에 600개(supabase/migrations/0002_events.sql).
 */
import { isDbFault } from './db.js';
import { json, readJson } from './http.js';

export const EVENT_NAMES = Object.freeze(['first_visit', 'session_start', 'match_start', 'match_end', 'ping', 'error']);
export const EVENTS_MAX = 20;
export const EVENTS_BODY_LIMIT = 16384;
export const PROPS_MAX_CHARS = 512;    // JSON으로 적었을 때 글자 수
export const PROPS_MAX_KEYS = 8;
export const IP_LIMIT = 240;           // 1분에 한 IP가 보낼 수 있는 사건 수(인스턴스마다)
export const IP_WINDOW_MS = 60000;

export const ID_RE = /^[a-f0-9]{32}$/;
const MODE_RE = /^[a-z0-9_-]{1,24}$/;
const MAP_RE = /^[a-z0-9_-]{1,32}$/;
const KEY_RE = /^[a-zA-Z0-9_]{1,24}$/;
const EVENT_KEYS = new Set(['name', 'at', 'mode', 'map', 'value', 'props']);
const BODY_KEYS = new Set(['anonId', 'sessionId', 'events']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** props: 칸 8개 이하, 이름은 영문·숫자·밑줄, 값은 120자 이하 글자·유한한 숫자·참거짓·null, 다 합쳐 512자 이하 */
function validProps(props) {
  if (!isPlain(props)) return false;
  const keys = Object.keys(props);
  if (keys.length > PROPS_MAX_KEYS) return false;
  for (const k of keys) {
    const v = props[k];
    if (!KEY_RE.test(k)) return false;
    if (v === null || typeof v === 'boolean') continue;
    if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string' || v.length > 120) return false;
  }
  return JSON.stringify(props).length <= PROPS_MAX_CHARS;
}

/** 사건 하나. 맞으면 DB에 넘길 모양, 틀리면 null */
export function cleanEvent(ev) {
  if (!isPlain(ev)) return null;
  for (const k of Object.keys(ev)) if (!EVENT_KEYS.has(k)) return null;
  if (!EVENT_NAMES.includes(ev.name)) return null;
  const out = { name: ev.name };
  if (ev.at !== undefined) {
    if (typeof ev.at !== 'number' || !Number.isFinite(ev.at) || ev.at < 0) return null;
    out.at = Math.round(ev.at);
  }
  if (ev.mode !== undefined && ev.mode !== null) {
    if (typeof ev.mode !== 'string' || !MODE_RE.test(ev.mode)) return null;
    out.mode = ev.mode;
  }
  if (ev.map !== undefined && ev.map !== null) {
    if (typeof ev.map !== 'string' || !MAP_RE.test(ev.map)) return null;
    out.map = ev.map;
  }
  if (ev.value !== undefined && ev.value !== null) {
    if (typeof ev.value !== 'number' || !Number.isFinite(ev.value) || Math.abs(ev.value) > 1e9) return null;
    out.value = ev.value;
  }
  if (ev.props !== undefined && ev.props !== null) {
    if (!validProps(ev.props)) return null;
    out.props = ev.props;
  }
  return out;
}

/** 본문 전체. 맞으면 { anonId, sessionId, events }, 틀리면 null(하나라도 틀리면 묶음 전체를 거절한다) */
export function readBatch(body) {
  if (!isPlain(body)) return null;
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) return null;
  if (!ID_RE.test(body.anonId || '') || !ID_RE.test(body.sessionId || '')) return null;
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > EVENTS_MAX) return null;
  const events = [];
  for (const ev of body.events) {
    const clean = cleanEvent(ev);
    if (!clean) return null;
    events.push(clean);
  }
  return { anonId: body.anonId, sessionId: body.sessionId, events };
}

/** 인스턴스 메모리의 IP별 1분 창. IP는 저장하지 않고 창이 지나면 잊는다 */
export function createIpLimiter({ limit = IP_LIMIT, windowMs = IP_WINDOW_MS, maxKeys = 5000 } = {}) {
  const hits = new Map();
  return {
    take(ip, n, now) {
      if (!ip) return true;
      const cur = hits.get(ip);
      if (!cur || now - cur.start >= windowMs) {
        if (!cur && hits.size >= maxKeys) hits.clear();   // 너무 많아지면 통째로 잊는다(메모리 보호)
        hits.set(ip, { start: now, n });
        return n <= limit;
      }
      cur.n += n;
      return cur.n <= limit;
    },
    reset() { hits.clear(); }
  };
}

const ipLimiter = createIpLimiter();
export const resetEventLimits = () => ipLimiter.reset();

/** POST /v1/events: { anonId, sessionId, events:[{ name, at?, mode?, map?, value?, props? }] } → { ok, n } */
export async function ingest(request, ctx) {
  const body = await readJson(request, EVENTS_BODY_LIMIT);
  const batch = body && readBatch(body);
  if (!batch) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  if (!ipLimiter.take(request.headers.get('cf-connecting-ip'), batch.events.length, ctx.now())) {
    return json({ ok: false, error: 'RATE_LIMITED' }, 429);
  }
  const r = await ctx.db.call('fps_api_log_events', { p_anon_id: batch.anonId, p_session_id: batch.sessionId, p_events: batch.events });
  if (r.ok === false && r.error === 'RATE_LIMITED') return json(r, 429);
  if (r.ok === false && !isDbFault(r)) return json(r, 400);
  return json(r, isDbFault(r) ? 503 : 200);
}
