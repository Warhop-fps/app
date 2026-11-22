/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버가 판정하는 방(server/의 게임 서버)에 붙는 브라우저 클라이언트. 접속·버전 맞추기(join v)·입력 보내기·받은 메시지 나눠 주기만 한다.
 *          아직 화면(세션)에 연결하지 않았다. SKALA_CONFIG.transport가 'server'이거나 주소에 ?server=1이 있고 gameServer.url이 있을 때만 켜진다(기본은 꺼짐).
 */
/**
 *   const url = gameServerUrl();                       // 꺼져 있으면 ''
 *   const gs = await connectGameServer({ url, room: 'abc', name: '하늘', opts: { mode: 'ffa', killTarget: 10 } });
 *   gs.on('snap', (m) => ...); gs.on('events', (m) => ...); gs.on('match', (m) => ...);
 *   gs.sendInput({ keys: inputKeys(state), press, yaw, pitch, viewTick });
 *   gs.respawn(); gs.start(); gs.close();
 *
 * 버전이 다르면 connectGameServer가 code 'RELOAD'(reload: true)인 오류로 끝난다. 화면은 t('net.reloadRequired') = "새로고침 필요"를 띄운다.
 */
import { Emitter, netError } from './realtime.js';
import { t } from '../core/i18n.js';
import { KEY, PROTOCOL } from './gameproto.js';

export { KEY, PRESS, PROTOCOL, ROW, CLOSE } from './gameproto.js';

const ROOM_RE = /^[a-z0-9]{1,16}$/;

/**
 * 켜져 있으면 게임 서버의 ws 주소, 아니면 ''. 지금 게임(중계 서버)은 그대로 두고, 설정이나 주소 깃발로만 켠다.
 * @param {object} [cfg] SKALA_CONFIG(기본 window 값)
 * @param {string} [search] location.search
 */
export function gameServerUrl(cfg = globalThis.SKALA_CONFIG || {}, search = (globalThis.location && globalThis.location.search) || '') {
  const raw = cfg && cfg.gameServer && typeof cfg.gameServer.url === 'string' ? cfg.gameServer.url.trim() : '';
  if (!raw) return '';
  let flag = false;
  try { flag = new URLSearchParams(search).get('server') === '1'; } catch (_) { flag = false; }
  if (cfg.transport !== 'server' && !flag) return '';
  const url = raw.replace(/^http/, 'ws').replace(/\/+$/, '');
  return /^wss?:\/\//.test(url) ? url : '';
}

/** 누르고 있는 키 상태 { forward, back, left, right, jump, crouch, walk, fire, aim } → input.keys 비트 */
export function inputKeys(s) {
  if (!s) return 0;
  let k = 0;
  if (s.forward) k |= KEY.FORWARD;
  if (s.back) k |= KEY.BACK;
  if (s.left) k |= KEY.LEFT;
  if (s.right) k |= KEY.RIGHT;
  if (s.jump) k |= KEY.JUMP;
  if (s.crouch) k |= KEY.CROUCH;
  if (s.walk) k |= KEY.WALK;
  if (s.fire) k |= KEY.FIRE;
  if (s.aim) k |= KEY.AIM;
  return k;
}

/** 서버의 error 메시지 → 화면에 보일 오류. 버전이 다르면 code 'RELOAD' */
export function gameServerError(m) {
  if (m && (m.reload || m.code === 'bad_version')) return netError('RELOAD', t('net.reloadRequired'), { reload: true, server: m.server ?? null });
  const code = m && typeof m.code === 'string' ? m.code : 'closed';
  if (code === 'room_full') return netError('ROOM_FULL', t('net.roomFull'), { server: code });
  return netError('GAME_SERVER', t('net.gameServerClosed', { code }), { server: code });
}

/**
 * 접속하고 welcome까지 기다린다.
 * @param {object} o
 * @param {string} o.url gameServerUrl()의 값(ws://… 또는 wss://…)
 * @param {string} o.room 방 id(소문자·숫자 1~16자)
 * @param {string} [o.name]
 * @param {string} [o.team]
 * @param {object} [o.opts] 방을 처음 만들 때 { map, mode, ruleset, killTarget }
 * @param {number} [o.version] 시험용(기본 PROTOCOL)
 * @param {number} [o.timeoutMs=10000]
 * @param {typeof WebSocket} [o.WebSocket]
 */
export function connectGameServer(o) {
  const WS = o.WebSocket || globalThis.WebSocket;
  if (!WS) return Promise.reject(netError('NO_WEBSOCKET', t('net.noWebSocket')));
  if (!o.url || !/^wss?:\/\//.test(o.url)) return Promise.reject(netError('NO_CONFIG', t('net.gameServerUrlMissing')));
  if (!ROOM_RE.test(String(o.room || ''))) return Promise.reject(netError('BAD_ROOM_ID', t('net.badRoomId')));
  const em = new Emitter();
  const ws = new WS(`${o.url}/room/${o.room}`);
  let seq = 0;
  let welcome = null;
  let lastError = null;
  let closed = false;
  const send = (obj) => { if (!closed && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail(netError('TIMEOUT', t('net.gameServerTimeout'))); try { ws.close(); } catch (_) { /* 닫히는 중 */ } }, o.timeoutMs || 10000);
    let settled = false;
    function fail(err) { if (settled) return; settled = true; clearTimeout(timer); reject(err); }

    ws.onopen = () => send({ t: 'join', v: o.version ?? PROTOCOL, name: o.name || '', team: o.team ?? null, opts: o.opts });
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch (_) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'error') { lastError = gameServerError(m); em.emit('error', lastError); return; }
      if (m.t === 'welcome' && !welcome) {
        welcome = m;
        settled = true;
        clearTimeout(timer);
        resolve(api);
      }
      em.emit(m.t, m);
    };
    ws.onclose = (e) => {
      closed = true;
      const err = lastError || netError('GAME_SERVER', t('net.gameServerClosed', { code: e && e.code }), { closeCode: e && e.code });
      fail(err);
      em.emit('close', { code: e && e.code, error: welcome ? lastError : err });
    };
    ws.onerror = () => { /* onclose가 이어서 온다 */ };

    const api = {
      get playerId() { return welcome ? welcome.playerId : null; },
      get welcome() { return welcome; },
      get closed() { return closed; },
      on: (ev, fn) => em.on(ev, fn),
      /** 입력 하나(서버 틱 하나). seq는 여기서 붙인다 */
      sendInput({ keys = 0, press = 0, slot = 0, yaw = 0, pitch = 0, viewTick } = {}) {
        const msg = { t: 'input', seq: seq++, keys: keys | 0, press: press | 0, slot: slot | 0, yaw: +yaw || 0, pitch: +pitch || 0 };
        if (Number.isFinite(viewTick)) msg.viewTick = viewTick;
        send(msg);
        return msg.seq;
      },
      pick: (weapon) => send({ t: 'pick', weapon }),
      setTeam: (team) => send({ t: 'team', team }),
      start: () => send({ t: 'start' }),
      respawn: () => send({ t: 'respawn' }),
      close() { closed = true; try { ws.close(1000, 'bye'); } catch (_) { /* 이미 닫힘 */ } }
    };
  });
}
