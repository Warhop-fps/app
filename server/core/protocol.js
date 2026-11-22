/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 메시지 형식. 클라이언트가 보내는 join·input·pick·team·start를 검사해 정규화하고(모르는 형식은 버린다),
 *          방 주소(/room/<id>)를 읽고, 서버가 보내는 스냅샷 줄의 칸 순서와 단위를 정한다. 소켓·플랫폼에 의존하지 않아 VM 어댑터와 Durable Objects가 함께 쓴다.
 */
/**
 * 접속: WebSocket `/room/<방 id>` (소문자·숫자 1~16자). 방 id는 주소가 정하므로 Durable Objects에서도 주소만으로 방 객체를 찾는다.
 * 전송: 텍스트 프레임 하나에 JSON 객체 하나. 필드 t가 형식이다. 자세한 표는 docs/SERVER.md 3절.
 *
 * 클라이언트 → 서버
 *   join  { t:'join', v, name, team?, opts?:{ map, mode, ruleset, killTarget } }   접속 후 한 번. opts는 방을 처음 만들 때만 쓴다
 *           v가 서버의 PROTOCOL과 다르면 error { code:'bad_version', reload:true, server }를 보내고 4002로 끊는다(화면은 "새로고침 필요")
 *   input { t:'input', seq, keys, press?, yaw, pitch, slot?, viewTick? }   입력 하나 = 서버 틱 하나(1/30초)
 *           seq 입력 번호(0..MAX_SEQ, 늘어나기만 한다)   keys 누르고 있는 키(KEY 비트)   press 이번 입력 사이에 새로 누른 키(PRESS 비트)
 *           yaw·pitch 시점(rad, pitch는 ±89°로 자른다)   slot 이번에 고른 무기 칸(1~4, 없으면 0)
 *           viewTick 이 입력을 만들 때 다른 사람을 그린 서버 틱(소수, 되감기 기준)
 *   pick  { t:'pick', weapon }   라운드 전 무기 선택(match.setLoadout)
 *   team  { t:'team', team }     대기실에서 팀 바꾸기
 *   start { t:'start' }          방장(가장 먼저 들어온 사람)만
 *   respawn { t:'respawn' }      개인전 즉시 부활(죽어서 기다리는 동안 E). 서버가 match.respawnNow로 판정하고 값(킬 보상 한 번)을 센다
 *
 * 서버 → 클라이언트
 *   welcome { t:'welcome', v, playerId, team, room, hz, tick, map, mode, ruleset, killTarget, leader, maxRewindMs, row }
 *   snap    { t:'snap', tick, players:[줄...], me:{...} }   틱마다. 줄 = ROW 순서의 배열, me = 받는 사람만의 상태
 *   events  { t:'events', tick, events:[...] }            경기 이벤트(match.js) + 사격·수류탄 연출 이벤트
 *   match   { t:'match', tick, match, leader, ping }       점수판(match.snapshot()). 이벤트가 있을 때와 0.5초마다
 *   error   { t:'error', code, message, reload?, server? } 끊기 직전의 이유. reload:true면 클라이언트를 새로고침해야 한다(버전이 다르다)
 *   경기 끝 보상은 events 안의 { type:'reward', id, summary, reward, quick } 로 그 사람에게만 간다(account.recordMatch의 모양)
 */
import { wrapAngle } from '../../js/engine/interp.js';
import { FLAG } from '../../js/game/protocol.js';
import { parseKillTarget } from '../../js/game/modes.js';
import { CLOSE, KEY, KEY_MASK, PRESS, PRESS_MASK, PROTOCOL, RELOAD_MESSAGE, ROW } from '../../js/net/gameproto.js';

export { FLAG };
// 판·키 비트·줄 칸·닫기 코드는 브라우저와 함께 쓰는 js/net/gameproto.js가 정본이다
export { PROTOCOL, RELOAD_MESSAGE, KEY, KEY_MASK, PRESS, PRESS_MASK, CLOSE, ROW };

export const MAX_SEQ = 0x7fffffff;
export const NAME_MAX = 24;
/** 방 id: 소문자·숫자 1~16자 */
export const ROOM_ID_RE = /^[a-z0-9]{1,16}$/;
const OPT_RE = /^[a-z0-9_-]{1,24}$/i;
const PITCH_LIMIT = (89 * Math.PI) / 180;
const MAX_ANGLE = 1e6;
const TEAMS = Object.freeze(['owner', 'charterer']);
const MODES = Object.freeze(['team', 'ffa']);

/** 클라이언트가 보낼 수 있는 형식. 이 밖의 t는 버린다 */
export const CLIENT_TYPES = Object.freeze(['join', 'input', 'pick', 'team', 'start', 'respawn']);

const cm = (v) => Math.round(v * 100);
const mrad = (v) => Math.round(v * 1000);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 경로 '/room/<id>' → 방 id. 형식이 틀리면 null */
export function roomIdFromPath(path) {
  const m = /^\/room\/([^/]+)$/.exec(typeof path === 'string' ? path : '');
  return m && ROOM_ID_RE.test(m[1]) ? m[1] : null;
}

/** 스냅샷 줄 만들기(room이 쓴다) */
export function encodeRow({ id, pos, yaw, pitch, flags, hp, weapon, ack }) {
  return [id, cm(pos[0]), cm(pos[1]), cm(pos[2]), mrad(yaw), mrad(pitch), flags | 0, hp | 0, weapon || '', ack];
}

/** 스냅샷 줄 읽기(가짜 클라이언트·시험이 쓴다) */
export function decodeRow(r) {
  const flags = r[ROW.FLAGS] | 0;
  return {
    id: r[ROW.ID],
    pos: [r[ROW.X] / 100, r[ROW.Y] / 100, r[ROW.Z] / 100],
    yaw: r[ROW.YAW] / 1000,
    pitch: r[ROW.PITCH] / 1000,
    flags,
    alive: !!(flags & FLAG.alive),
    crouch: !!(flags & FLAG.crouch),
    onGround: !!(flags & FLAG.onGround),
    hp: r[ROW.HP],
    weapon: r[ROW.WEAPON],
    ack: r[ROW.ACK]
  };
}

/**
 * 이름 정리: 제어 문자와 글자 방향을 뒤집는 문자(사칭에 쓰인다)를 지우고 앞뒤 공백을 뺀 뒤 NAME_MAX 글자에서 자른다.
 * 서로게이트 쌍을 반으로 자르지 않게 코드 포인트 단위로 자른다.
 */
export function cleanName(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

function cleanOpts(o) {
  const out = { map: null, mode: null, ruleset: null, killTarget: null };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  if (typeof o.map === 'string' && OPT_RE.test(o.map)) out.map = o.map;
  if (typeof o.mode === 'string' && MODES.includes(o.mode)) out.mode = o.mode;
  if (typeof o.ruleset === 'string' && OPT_RE.test(o.ruleset)) out.ruleset = o.ruleset;
  if (o.killTarget !== undefined && o.killTarget !== null) out.killTarget = parseKillTarget(o.killTarget);   // 5~20으로 자른다(modes.FFA_KILLS)
  return out;
}

const intOr = (v, d) => (v === undefined || v === null ? d : Number.isInteger(v) ? v : NaN);

/** 형식별 검사. 틀리면 null(메시지를 버린다) */
const DECODERS = Object.freeze(Object.assign(Object.create(null), {
  join(v) {
    if (!Number.isInteger(v.v)) return null;
    return { t: 'join', v: v.v, name: cleanName(v.name), team: TEAMS.includes(v.team) ? v.team : null, opts: cleanOpts(v.opts) };
  },
  input(v) {
    const seq = v.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return null;
    const keys = intOr(v.keys, 0), slot = intOr(v.slot, 0), press = intOr(v.press, 0);
    if (Number.isNaN(keys) || Number.isNaN(slot) || Number.isNaN(press) || slot < 0 || slot > 4) return null;
    if (!isNum(v.yaw) || !isNum(v.pitch) || Math.abs(v.yaw) > MAX_ANGLE || Math.abs(v.pitch) > MAX_ANGLE) return null;
    let viewTick = null;
    if (v.viewTick !== undefined && v.viewTick !== null) {
      if (!isNum(v.viewTick)) return null;
      viewTick = v.viewTick;
    }
    return {
      t: 'input', seq, keys: keys & KEY_MASK, press: press & PRESS_MASK,
      yaw: wrapAngle(v.yaw), pitch: clamp(v.pitch, -PITCH_LIMIT, PITCH_LIMIT), slot, viewTick
    };
  },
  pick(v) {
    return typeof v.weapon === 'string' && v.weapon.length <= 24 ? { t: 'pick', weapon: v.weapon } : null;
  },
  team(v) {
    return TEAMS.includes(v.team) ? { t: 'team', team: v.team } : null;
  },
  start() {
    return { t: 'start' };
  },
  respawn() {
    return { t: 'respawn' };
  }
}));

/**
 * 받은 글자 하나를 검사한다. 던지지 않는다.
 * @param {string} text
 * @returns {{ok:true, msg:object} | {ok:false, reason:'bad_json'|'bad_shape'|'unknown_type'|'bad_field'}}
 */
export function decodeClient(text) {
  let v;
  try { v = JSON.parse(text); } catch { return { ok: false, reason: 'bad_json' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'bad_shape' };
  if (typeof v.t !== 'string' || !Object.hasOwn(DECODERS, v.t)) return { ok: false, reason: 'unknown_type' };
  const msg = DECODERS[v.t](v);
  return msg ? { ok: true, msg } : { ok: false, reason: 'bad_field' };
}

/** 끊기 직전에 보내는 이유 */
export function encodeError(code, message = '', extra = null) {
  return JSON.stringify({ t: 'error', code, message, ...(extra && typeof extra === 'object' ? extra : {}) });
}

/** 버전이 다를 때의 error 메시지. 클라이언트는 reload를 보고 "새로고침 필요"를 띄운다 */
export function encodeVersionError(clientV) {
  return encodeError('bad_version', RELOAD_MESSAGE, { reload: true, server: PROTOCOL, client: Number.isInteger(clientV) ? clientV : null });
}
