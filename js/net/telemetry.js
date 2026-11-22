/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 사용 기록(익명). 사건을 모아 API Worker의 POST /v1/events로 보낸다(sendBeacon 또는 fetch keepalive).
 *          보내는 것: 처음 방문(first_visit), 세션 시작, 경기 시작·끝(모드·맵·걸린 초), 5분마다 ping, 화면 오류(error, 세션당 5개).
 *          이름·이메일·IP·기기 토큰은 보내지 않는다. 신원은 이 브라우저가 만든 무작위 번호(anon_id, localStorage)뿐이다.
 *          꺼지는 때: API 주소(SKALA_CONFIG.api.url)가 없을 때, 브라우저가 아닐 때(Node 시험), 자동 조작 브라우저(QA),
 *          localhost·127.0.0.1(?telemetry=1이면 켠다), ?telemetry=0, 추적 거부(Do Not Track·GPC). 무슨 일이 있어도 게임 코드로 예외를 던지지 않는다.
 */
import { readApiUrl } from '../account/api.js';

export const EVENTS_PATH = '/v1/events';
export const BATCH_MAX = 20;          // server/api/src/events.js EVENTS_MAX와 같다
export const QUEUE_MAX = 100;         // 못 보낸 사건을 이보다 많이 쌓지 않는다(오래된 것부터 버린다)
export const FLUSH_MS = 15000;        // 첫 사건 뒤 이만큼 기다렸다가 보낸다
export const PING_MS = 5 * 60 * 1000; // 화면이 보이는 동안 ping 간격
export const PING_MAX = 24;           // 세션당 ping 수(2시간)
export const ERROR_MAX = 5;           // 세션당 오류 수
export const ANON_KEY = 'skalafps.anon';

const ID_RE = /^[a-f0-9]{32}$/;
const MODE_RE = /^[a-z0-9_-]{1,24}$/;
const MAP_RE = /^[a-z0-9_-]{1,32}$/;

const noop = () => {};
const OFF = Object.freeze({ enabled: false, reason: 'off', anonId: null, sessionId: null, track: noop, flush: noop, install: () => noop, pending: () => 0 });

/** 32자 hex 무작위 번호 */
function randomId(env) {
  try {
    const bytes = new Uint8Array(16);
    env.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    let s = '';
    for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
}

/** 켤지 판단. 끄는 까닭(문자열) 또는 null */
export function offReason(env, url) {
  if (!url) return 'no_api';
  if (!env || typeof env !== 'object' || !env.document || !env.location || !env.navigator) return 'not_browser';
  const nav = env.navigator;
  if (nav.webdriver) return 'automation';
  if (typeof nav.sendBeacon !== 'function' && typeof env.fetch !== 'function') return 'no_transport';
  let params;
  try { params = new URLSearchParams(env.location.search || ''); } catch (_) { params = new URLSearchParams(); }
  if (params.get('telemetry') === '0') return 'opt_out';
  if (nav.doNotTrack === '1' || env.doNotTrack === '1' || nav.globalPrivacyControl === true) return 'do_not_track';
  const host = String(env.location.hostname || '');
  if ((host === 'localhost' || host === '127.0.0.1' || host === '[::1]') && params.get('telemetry') !== '1') return 'local';
  if (params.has('autoplay') && params.get('autoplay') !== '0') return 'automation';
  return null;
}

/** 모드·맵 id. 서버 규칙(소문자·숫자·-·_)에 맞지 않으면 뺀다 */
function cleanId(value, re) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return re.test(v) ? v : undefined;
}

/** 오류 글에서 개인 정보처럼 보이는 것(이메일, 주소의 ?뒤)을 지우고 120자로 자른다 */
export function scrubText(value, max = 120) {
  return String(value == null ? '' : value)
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/(https?:\/\/[^\s?#]*)[?#][^\s]*/g, '$1')
    .slice(0, max);
}

/** 오류가 난 파일 이름만(경로·주소는 빼고) */
function fileOf(src) {
  const s = String(src || '').split(/[?#]/)[0];
  return s.slice(s.lastIndexOf('/') + 1).slice(0, 60);
}

/**
 * opts: { config?: { url }, env?: window 같은 객체(시험용), now?: () => ms }
 * 반환: { enabled, reason, anonId, sessionId, track(name, fields), flush(unloading), install({ bus }), pending() }
 */
export function createTelemetry({ config, env = globalThis, now } = {}) {
  try {
    const url = readApiUrl(config || (env && env.SKALA_CONFIG && env.SKALA_CONFIG.api) || undefined);
    const reason = offReason(env, url);
    if (reason) return { ...OFF, reason };
    return start(env, url + EVENTS_PATH, now || (() => Date.now()));
  } catch (_) {
    return { ...OFF, reason: 'error' };
  }
}

function start(env, endpoint, now) {
  let anonId = null;
  let firstVisit = false;
  try {
    const saved = env.localStorage.getItem(ANON_KEY);
    if (saved && ID_RE.test(saved)) anonId = saved;
    else {
      anonId = randomId(env);
      env.localStorage.setItem(ANON_KEY, anonId);
      firstVisit = env.localStorage.getItem(ANON_KEY) === anonId;   // 저장이 안 되면(사생활 보호 창) 처음 방문인지 알 수 없다
    }
  } catch (_) {
    anonId = anonId || randomId(env);
  }
  const sessionId = randomId(env);
  const startedAt = now();
  const queue = [];
  let timer = null;
  let errors = 0;
  let pings = 0;

  function send(events, unloading) {
    const text = JSON.stringify({ anonId, sessionId, events });
    // text/plain이면 브라우저가 사전 요청(OPTIONS) 없이 보낸다. Worker는 본문을 JSON으로 읽는다
    const type = 'text/plain;charset=UTF-8';
    const nav = env.navigator;
    if (unloading && typeof nav.sendBeacon === 'function') {
      try {
        const blob = typeof env.Blob === 'function' ? new env.Blob([text], { type }) : text;
        if (nav.sendBeacon(endpoint, blob)) return;
      } catch (_) { /* fetch로 */ }
    }
    if (typeof env.fetch !== 'function') return;
    try {
      const p = env.fetch(endpoint, {
        method: 'POST', body: text, headers: { 'content-type': type },
        keepalive: true, credentials: 'omit', cache: 'no-store', mode: 'cors'
      });
      if (p && typeof p.catch === 'function') p.catch(noop);
    } catch (_) { /* 기록은 버린다 */ }
  }

  function flush(unloading = false) {
    try {
      if (timer) { env.clearTimeout(timer); timer = null; }
      while (queue.length) send(queue.splice(0, BATCH_MAX), unloading);
    } catch (_) { /* 무시 */ }
  }

  function schedule() {
    if (queue.length >= BATCH_MAX) { flush(false); return; }
    if (!timer && typeof env.setTimeout === 'function') timer = env.setTimeout(() => { timer = null; flush(false); }, FLUSH_MS);
  }

  /** fields: { mode?, map?, value?, props? } */
  function track(name, fields = {}) {
    try {
      const ev = { name, at: now() };
      const f = fields || {};
      const mode = cleanId(f.mode, MODE_RE);
      const map = cleanId(f.map, MAP_RE);
      if (mode) ev.mode = mode;
      if (map) ev.map = map;
      if (typeof f.value === 'number' && Number.isFinite(f.value) && Math.abs(f.value) <= 1e9) ev.value = Math.round(f.value * 10) / 10;
      if (f.props && typeof f.props === 'object' && !Array.isArray(f.props)) {
        const props = {};
        for (const [k, v] of Object.entries(f.props).slice(0, 8)) {
          if (!/^[a-zA-Z0-9_]{1,24}$/.test(k)) continue;
          if (typeof v === 'string') props[k] = scrubText(v);
          else if (typeof v === 'boolean' || v === null) props[k] = v;
          else if (typeof v === 'number' && Number.isFinite(v)) props[k] = v;
        }
        if (Object.keys(props).length && JSON.stringify(props).length <= 512) ev.props = props;
      }
      queue.push(ev);
      if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
      schedule();
    } catch (_) { /* 무시 */ }
  }

  function trackError(message, src, line) {
    if (errors >= ERROR_MAX) return;
    errors += 1;
    track('error', { props: { msg: scrubText(message), src: fileOf(src), line: Number.isFinite(line) ? line : 0 } });
  }

  /** bus의 화면 전환으로 경기 시작·끝을 잰다. 'sandbox'(연습장)도 경기로 센다(mode 'sandbox') */
  function install({ bus } = {}) {
    const offs = [];
    try {
      if (firstVisit) track('first_visit');
      track('session_start', { props: { touch: !!(env.matchMedia && env.matchMedia('(pointer: coarse)').matches) } });

      let match = null;   // { at, mode, map }
      const endMatch = (to) => {
        if (!match) return;
        track('match_end', { mode: match.mode, map: match.map, value: (now() - match.at) / 1000, props: { to: String(to || 'close') } });
        match = null;
      };
      if (bus && typeof bus.on === 'function') {
        const off = bus.on('screen:change', (e) => {
          try {
            const to = e && e.to;
            const p = (e && e.params) || {};
            if (match && to !== match.screen) endMatch(to);
            if ((to === 'match' || to === 'sandbox') && !match) {
              match = { at: now(), screen: to, mode: to === 'sandbox' ? 'sandbox' : p.mode, map: p.mapId };
              track('match_start', { mode: match.mode, map: match.map });
            }
          } catch (_) { /* 무시 */ }
        });
        if (typeof off === 'function') offs.push(off);
      }

      const listen = (target, type, fn) => {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, fn);
        offs.push(() => target.removeEventListener(type, fn));
      };
      listen(env, 'error', (e) => { try { trackError(e && (e.message || (e.error && e.error.message)), e && e.filename, e && e.lineno); } catch (_) { /* 무시 */ } });
      listen(env, 'unhandledrejection', (e) => {
        try { const r = e && e.reason; trackError('unhandled: ' + ((r && r.message) || r), r && r.fileName, 0); } catch (_) { /* 무시 */ }
      });
      listen(env, 'pagehide', () => { endMatch('close'); flush(true); });
      listen(env.document, 'visibilitychange', () => { if (env.document.visibilityState === 'hidden') flush(true); });

      if (typeof env.setInterval === 'function') {
        const id = env.setInterval(() => {
          if (pings >= PING_MAX || (env.document && env.document.visibilityState === 'hidden')) return;
          pings += 1;
          track('ping', { value: (now() - startedAt) / 1000 });
        }, PING_MS);
        offs.push(() => env.clearInterval(id));
      }
    } catch (_) { /* 무시 */ }
    return () => { for (const off of offs.splice(0)) { try { off(); } catch (_) { /* 무시 */ } } };
  }

  return { enabled: true, reason: null, anonId, sessionId, track, flush, install, pending: () => queue.length };
}

let shared = null;

/** main.js가 부른다: 한 번만 만들고 bus에 건다. 꺼져 있으면 아무것도 하지 않는다 */
export function installTelemetry({ bus } = {}) {
  try {
    if (!shared) shared = createTelemetry();
    return shared.install({ bus });
  } catch (_) {
    return noop;
  }
}
