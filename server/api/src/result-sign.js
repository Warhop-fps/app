/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 결과 서명·검증(공용). 게임 서버(Node 20, EC2)가 서명하고 API Worker(POST /v1/match-result)가 검증한다.
 *          WebCrypto(globalThis.crypto)와 TextEncoder·btoa·atob만 써서 Workers와 Node 양쪽에서 그대로 import 한다. 다른 파일을 import 하지 않는다.
 *          약속(모양·정규 직렬화·서명·시간 창·한도)은 docs/MATCH_RESULT_CONTRACT.md. 이 파일을 바꾸면 그 문서와 시험 벡터도 같이 바꾼다.
 */

export const RESULT_PROTOCOL = 1;                 // result.protocol 값
export const SIG_SCOPE = 'skala-match-result.v1.'; // 서명할 글자 앞에 붙인다(다른 서명과 섞이지 않게)
export const KID_SCOPE = 'skala-result-kid.v1.';   // 열쇠 번호를 만들 때 비밀 값 앞에 붙인다
export const SECRET_MIN = 32;                      // 비밀 값 최소 글자 수
export const WINDOW_MS = 10 * 60 * 1000;           // signedAt이 Worker 시계와 이만큼 넘게 다르면 거절
export const MAX_PLAYERS = 32;                     // 한 경기 사람 수 상한(지금 방은 16인까지)
export const MAX_POINTS = 2000;                    // 한 사람이 한 경기로 받는 포인트 상한
export const MAX_COUNT = 10000;                    // kills·deaths 상한
export const MAX_MATCH_MS = 6 * 60 * 60 * 1000;    // 경기 길이 상한(배틀로얄도 1시간)

export const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SERVER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MODE_RE = /^[a-z0-9_-]{1,24}$/;
export const MAP_RE = /^[a-z0-9_-]{1,32}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const KID_RE = /^k[0-9a-f]{16}$/;

const RESULT_KEYS = ['protocol', 'resultId', 'roomId', 'matchSeq', 'serverId', 'mode', 'map', 'startedAt', 'endedAt', 'signedAt', 'players'];
const PLAYER_KEYS = ['tokenHash', 'kills', 'deaths', 'placement', 'points'];
const ENVELOPE_KEYS = ['kid', 'sig', 'result'];

const enc = new TextEncoder();
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const sameKeys = (o, keys) => {
  const got = Object.keys(o);
  return got.length === keys.length && keys.every((k) => hasOwn(o, k));
};

/**
 * 정규 직렬화: 객체 열쇠를 사전순(UTF-16 코드 단위, JS 기본 sort)으로 늘어놓고 빈칸 없이 JSON으로 적는다.
 * 값은 글자·안전한 정수·true/false·null·배열·평범한 객체만. 소수·NaN·undefined·함수 등이 있으면 예외(TypeError).
 */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('정수만 적을 수 있습니다');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isPlain(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new TypeError('적을 수 없는 값입니다');
}

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(text)) return null;   // HMAC-SHA256 = 32바이트 = 43글자
  try {
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '=');
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out.length === 32 ? out : null;
  } catch (_) {
    return null;
  }
}

export function secretReady(secret) {
  return typeof secret === 'string' && secret.length >= SECRET_MIN;
}

const keys = new Map();
function hmacKey(secret) {
  if (!keys.has(secret)) {
    keys.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keys.get(secret);
}

/** 열쇠 번호(kid): 'k' + hex(SHA-256(KID_SCOPE + 비밀 값))의 앞 16글자. 비밀 값에서 저절로 나오므로 따로 설정하지 않는다 */
export async function keyId(secret) {
  if (!secretReady(secret)) throw new Error('GAME_RESULT_SECRET이 없거나 32글자보다 짧습니다');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(KID_SCOPE + secret)));
  return 'k' + Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 서명할 글자 = SIG_SCOPE + 정규 직렬화(result) */
export function signingText(result) {
  return SIG_SCOPE + canonicalize(result);
}

/** result의 모양을 본다. 맞으면 null, 틀리면 짧은 이유(영문) */
export function resultProblem(r) {
  if (!isPlain(r) || !sameKeys(r, RESULT_KEYS)) return 'keys';
  if (r.protocol !== RESULT_PROTOCOL) return 'protocol';
  if (typeof r.roomId !== 'string' || !ROOM_RE.test(r.roomId)) return 'roomId';
  if (!isInt(r.matchSeq, 1, 1e9)) return 'matchSeq';
  if (r.resultId !== `${r.roomId}:${r.matchSeq}`) return 'resultId';
  if (typeof r.serverId !== 'string' || !SERVER_RE.test(r.serverId)) return 'serverId';
  if (typeof r.mode !== 'string' || !MODE_RE.test(r.mode)) return 'mode';
  if (typeof r.map !== 'string' || !MAP_RE.test(r.map)) return 'map';
  for (const k of ['startedAt', 'endedAt', 'signedAt']) if (!isInt(r[k], 1e12, 1e14)) return k;
  if (r.endedAt < r.startedAt || r.endedAt - r.startedAt > MAX_MATCH_MS) return 'endedAt';
  if (r.signedAt < r.endedAt) return 'signedAt';
  if (!Array.isArray(r.players) || r.players.length < 1 || r.players.length > MAX_PLAYERS) return 'players';
  const seen = new Set();
  for (const p of r.players) {
    if (!isPlain(p) || !sameKeys(p, PLAYER_KEYS)) return 'player.keys';
    if (typeof p.tokenHash !== 'string' || !HASH_RE.test(p.tokenHash)) return 'player.tokenHash';
    if (seen.has(p.tokenHash)) return 'player.duplicate';
    seen.add(p.tokenHash);
    if (!isInt(p.kills, 0, MAX_COUNT) || !isInt(p.deaths, 0, MAX_COUNT)) return 'player.count';
    if (p.placement !== null && !isInt(p.placement, 1, MAX_PLAYERS)) return 'player.placement';
    if (!isInt(p.points, 0, MAX_POINTS)) return 'player.points';
  }
  return null;
}

/**
 * 게임 서버 쪽: result에 서명한 봉투 { kid, sig, result }를 만든다. 이것을 JSON.stringify 해서 POST 본문으로 보낸다.
 * result.signedAt은 부르는 쪽이 지금 시각(ms)으로 채운다. 모양이 틀리면 예외.
 */
export async function signResult(result, secret) {
  const problem = resultProblem(result);
  if (problem) throw new Error(`경기 결과 모양이 틀렸습니다: ${problem}`);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signingText(result)));
  return { kid: await keyId(secret), sig: b64url(new Uint8Array(sig)), result };
}

/**
 * Worker 쪽: 봉투를 검증한다. secrets = [지금 값, 이전 값](비었거나 짧은 값은 건너뛴다).
 * 순서: 봉투 모양 → kid로 열쇠 찾기 → 서명(crypto.subtle.verify, 시간 차이로 새지 않음) → result 모양 → 시간 창.
 * → { ok:true, result, kid } 또는 { ok:false, error } (error: BAD_REQUEST | UNKNOWN_KID | BAD_SIGNATURE | RESULT_INVALID | RESULT_STALE)
 */
export async function verifyEnvelope(envelope, secrets, now = Date.now()) {
  if (!isPlain(envelope) || !sameKeys(envelope, ENVELOPE_KEYS)) return { ok: false, error: 'BAD_REQUEST' };
  const { kid, sig, result } = envelope;
  if (typeof kid !== 'string' || !KID_RE.test(kid)) return { ok: false, error: 'BAD_REQUEST' };
  let secret = null;
  for (const s of secrets || []) {
    if (secretReady(s) && (await keyId(s)) === kid) { secret = s; break; }
  }
  if (!secret) return { ok: false, error: 'UNKNOWN_KID' };
  const sigBytes = fromB64url(sig);
  if (!sigBytes) return { ok: false, error: 'BAD_SIGNATURE' };
  let text;
  try {
    text = signingText(result);
  } catch (_) {
    return { ok: false, error: 'RESULT_INVALID' };
  }
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(text)))) return { ok: false, error: 'BAD_SIGNATURE' };
  const problem = resultProblem(result);
  if (problem) return { ok: false, error: 'RESULT_INVALID', problem };
  if (Math.abs(now - result.signedAt) > WINDOW_MS) return { ok: false, error: 'RESULT_STALE' };
  return { ok: true, result, kid };
}
