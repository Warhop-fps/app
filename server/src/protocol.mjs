/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 메시지 형식. 클라이언트가 보내는 join·in·pick·team·start를 검사해 정규화하고(모르는 형식은 버린다),
 *          서버가 보내는 스냅샷 줄의 칸 순서와 단위를 정한다. 소켓·방 상태에 의존하지 않는 순수 모듈이다.
 */
/**
 * 전송: WebSocket 텍스트 프레임 하나에 JSON 객체 하나. 필드 t가 형식이다. 자세한 표는 docs/SERVER.md 3절.
 *
 * 클라이언트 → 서버
 *   join  { t:'join', v, room, name, team?, opts?:{ map, mode, ruleset } }   접속 후 한 번. opts는 방을 처음 만들 때만 쓴다
 *   in    { t:'in', s, k, y, p, w?, b?, vt? }   입력 하나 = 서버 틱 하나(1/30초)
 *           s  입력 번호(0..MAX_SEQ, 늘어나기만 한다)    k  누르고 있는 키(KEY 비트)
 *           y  yaw(rad)   p  pitch(rad, ±89°로 자른다)   w  이번에 고른 무기 칸(1~4, 없으면 0)
 *           b  이번 입력 사이에 새로 누른 키(PRESS 비트)   vt 이 입력을 만들 때 화면에 그린 서버 틱(소수, 되감기 기준)
 *   pick  { t:'pick', w }      라운드 전 무기 선택(match.setLoadout)
 *   team  { t:'team', team }   대기실에서 팀 바꾸기
 *   start { t:'start' }        방장(가장 먼저 들어온 사람)만
 *
 * 서버 → 클라이언트
 *   welcome { t:'welcome', v, id, team, room, hz, tick, map, mode, ruleset, leader, maxRewindMs, row }
 *   s       { t:'s', k, p:[줄...], me:{...} }   스냅샷(틱마다). 줄 = ROW 순서의 배열, me = 받는 사람만의 상태
 *   e       { t:'e', k, e:[이벤트...] }        경기 이벤트(match.js) + 사격·수류탄 연출 이벤트
 *   m       { t:'m', k, m:snapshot, leader, ping }   점수판(match.snapshot()). 이벤트가 있을 때와 0.5초마다
 *   err     { t:'err', code, msg }             끊기 직전의 이유
 */
import { wrapAngle } from '../../js/engine/interp.js';
import { FLAG } from '../../js/game/protocol.js';

export { FLAG };

export const PROTOCOL = 1;

/** 누르고 있는 키(in.k) */
export const KEY = Object.freeze({
  FORWARD: 1, BACK: 2, LEFT: 4, RIGHT: 8, JUMP: 16, CROUCH: 32, WALK: 64, FIRE: 128, AIM: 256
});
export const KEY_MASK = 0x1ff;

/** 이번 입력 사이에 새로 누른 키(in.b). 한 입력 안에서 눌렀다 뗀 클릭도 놓치지 않으려고 따로 싣는다 */
export const PRESS = Object.freeze({ JUMP: 1, FIRE: 2, AIM: 4, RELOAD: 8, NEXT: 16, PREV: 32 });
export const PRESS_MASK = 0x3f;

export const MAX_SEQ = 0x7fffffff;
export const NAME_MAX = 24;
const ROOM_RE = /^[a-z0-9_-]{1,32}$/;
const OPT_RE = /^[a-z0-9_-]{1,24}$/i;
const PITCH_LIMIT = (89 * Math.PI) / 180;
const MAX_ANGLE = 1e6;
const TEAMS = Object.freeze(['owner', 'charterer']);
const MODES = Object.freeze(['team', 'ffa']);

/** 클라이언트가 보낼 수 있는 형식. 이 밖의 t는 버린다 */
export const CLIENT_TYPES = Object.freeze(['join', 'in', 'pick', 'team', 'start']);

/** 끊을 때 쓰는 닫기 코드. 1xxx는 WebSocket 표준, 4xxx는 이 서버가 정한 값 */
export const CLOSE = Object.freeze({
  NORMAL: 1000, GOING_AWAY: 1001, POLICY: 1008, TOO_BIG: 1009,
  ROOM_FULL: 4001, BAD_VERSION: 4002, JOIN_TIMEOUT: 4003, SERVER_FULL: 4004, BAD_JOIN: 4005, SLOW: 4006, ROOM_ERROR: 4007
});

/**
 * 스냅샷 줄의 칸 순서. 위치 cm 정수, 각도 mrad(0.001 rad) 정수, flags는 js/game/protocol.js의 FLAG 비트(브라우저 상태 메시지와 같다).
 * ack = 그 사람의 입력 중 서버가 마지막으로 처리한 번호(클라이언트 예측·보정의 기준).
 */
export const ROW = Object.freeze({ ID: 0, X: 1, Y: 2, Z: 3, YAW: 4, PITCH: 5, FLAGS: 6, HP: 7, WEAPON: 8, ACK: 9 });

const cm = (v) => Math.round(v * 100);
const mrad = (v) => Math.round(v * 1000);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
  const s =v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

function cleanOpts(o) {
  const out = { map: null, mode: null, ruleset: null };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  if (typeof o.map === 'string' && OPT_RE.test(o.map)) out.map = o.map;
  if (typeof o.mode === 'string' && MODES.includes(o.mode)) out.mode = o.mode;
  if (typeof o.ruleset === 'string' && OPT_RE.test(o.ruleset)) out.ruleset = o.ruleset;
  return out;
}

const intOr = (v, d) => (v === undefined || v === null ? d : Number.isInteger(v) ? v : NaN);

/** 형식별 검사. 틀리면 null(메시지를 버린다) */
const DECODERS = Object.freeze(Object.assign(Object.create(null), {
  join(v) {
    if (!Number.isInteger(v.v)) return null;
    const room = typeof v.room === 'string' ? v.room.trim().toLowerCase() : '';
    if (!ROOM_RE.test(room)) return null;
    return { t: 'join', v: v.v, room, name: cleanName(v.name), team: TEAMS.includes(v.team) ? v.team : null, opts: cleanOpts(v.opts) };
  },
  in(v) {
    const s = v.s;
    if (!Number.isInteger(s) || s < 0 || s > MAX_SEQ) return null;
    const k = intOr(v.k, 0), w = intOr(v.w, 0), b = intOr(v.b, 0);
    if (Number.isNaN(k) || Number.isNaN(w) || Number.isNaN(b) || w < 0 || w > 4) return null;
    if (!isNum(v.y) || !isNum(v.p) || Math.abs(v.y) > MAX_ANGLE || Math.abs(v.p) > MAX_ANGLE) return null;
    let vt = null;
    if (v.vt !== undefined && v.vt !== null) {
      if (!isNum(v.vt)) return null;
      vt = v.vt;
    }
    return { t: 'in', s, k: k & KEY_MASK, y: wrapAngle(v.y), p: clamp(v.p, -PITCH_LIMIT, PITCH_LIMIT), w, b: b & PRESS_MASK, vt };
  },
  pick(v) {
    return typeof v.w === 'string' && v.w.length <= 24 ? { t: 'pick', w: v.w } : null;
  },
  team(v) {
    return TEAMS.includes(v.team) ? { t: 'team', team: v.team } : null;
  },
  start() {
    return { t: 'start' };
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
export function encodeError(code, msg = '') {
  return JSON.stringify({ t: 'err', code, msg });
}
