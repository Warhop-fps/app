/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: VM용 Node 어댑터. HTTP(/healthz·/metrics)와 WebSocket(/room/<id>)을 받고, 접속마다 크기·속도 제한과 위반 점수를 적용해
 *          검사를 통과한 메시지만 방(core/room.js)으로 넘긴다. 모든 방을 고정 틱 루프 하나로 돌리고, 방별 틱 시간·초당 메시지를 로그와 지표로 낸다.
 */
/**
 *   const server = await startServer({ port: 8787 });   // config.DEFAULTS 위에 덮어쓴다
 *   server.url              // ws://127.0.0.1:8787   (방 주소는 server.roomUrl('abc') = ws://127.0.0.1:8787/room/abc)
 *   await server.close();
 *
 * 접속 하나의 길
 *   업그레이드: 경로 /room/<id> → Origin(설정했을 때, 값이 없는 브라우저 밖 클라이언트는 통과) → 전체 접속 수 → IP당 접속 수 → WebSocket
 *   메시지: 바이너리 거절 → 크기(maxMessageBytes) → 속도(토큰 버킷) → 형식 검사(protocol.decodeClient) → join 또는 방으로
 *   위반(깨진 JSON, 큰 메시지, 과속, 모르는 형식)은 점수로 쌓이고 strikeLimit을 넘으면 1008로 끊는다.
 *   join 없이 joinTimeoutMs가 지나면, ping에 기한 안에 답이 없으면, 보낼 데이터가 maxBufferedBytes보다 쌓이면 끊는다.
 * 신원(playerId)은 이 어댑터가 정한다. 클라이언트가 보낸 id는 어디에도 쓰지 않는다.
 * 로그에는 IP 원문 대신 프로세스마다 다른 소금을 친 해시 앞자리만 남긴다(docs/SECURITY.md 1절과 같은 원칙).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { RULESET_IDS } from '../../js/game/modes.js';
import { TokenBucket, createStrikes } from '../core/limits.js';
import { MAP_CHOICES } from '../core/maps.js';
import { CLOSE, PROTOCOL, decodeClient, encodeError, encodeVersionError, roomIdFromPath } from '../core/protocol.js';
import { createRoom } from '../core/room.js';
import { DEFAULTS } from './config.js';
import { createLogger } from './log.js';
import { createLoop } from './loop.js';
import { createMetrics } from './metrics.js';
import { createResultPoster } from './results.js';
import { createProcessStats, createRate, createSampler } from './rolling.js';

export const SERVER_VERSION = '0.1.0';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const emptyWindow = () => ({ msgIn: 0, msgOut: 0, bytesOut: 0, tickMs: 0, tickMax: 0, ticks: 0 });

/**
 * @param {object} [options] config.DEFAULTS의 키 + { log }(로거를 직접 줄 때)
 * @returns {Promise<{url:string, roomUrl:(id:string) => string, httpUrl:string, port:number, close:() => Promise<void>, stats:() => object, metrics:object, rooms:Map}>}
 */
export async function startServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const log = options.log || createLogger({ level: cfg.logLevel });
  const master = mulberry32(cfg.seed ?? randomInt(0, 0xffffffff));
  const ipSalt = randomBytes(16);
  const rooms = new Map();
  const conns = new Set();
  const byPlayer = new Map();    // playerId → 접속
  const perIp = new Map();
  const roomsByIp = new Map();   // 만든 사람 IP → 그 IP가 만든 열린 방 수
  const startedAt = Date.now();
  let connSeq = 0;
  let playerSeq = 0;
  let roomSerial = 0;
  // 결과 번호(resultId)가 서버를 다시 띄워도, 같은 방 id를 다시 써도 겹치지 않게 프로세스마다 다른 꼬리를 붙인다
  const bootId = randomBytes(4).toString('hex');
  const serverId = cfg.serverId || 'local';
  const poster = options.poster || createResultPoster({ url: cfg.resultUrl, secret: cfg.resultSecret, log, fetch: options.fetch });
  let closing = false;
  // 통계 창: statsIntervalMs마다 로그 한 줄씩(서버 전체 + 방마다) 내고 비운다
  let win = { ...emptyWindow(), start: performance.now() };
  let roomWin = new Map();
  let lastWindow = null;

  // 최근 값: 틱 시간 분위수(최근 30초 = 900틱), 초당 바이트·메시지(최근 10초), 프로세스 CPU·메모리(1초 간격)
  const tickSamples = createSampler(cfg.hz * 30);
  const rate = createRate({ windowSec: 10 });
  const proc = createProcessStats();
  const totals = { bytesOut: 0, msgOut: 0, msgIn: 0, cpuUs: 0 };
  const cpuNow = () => { const c = process.cpuUsage(); return c.user + c.system; };
  const cpuStart = cpuNow();

  const metrics = createMetrics();
  metrics.declare('skala_connections', 'gauge', '열린 WebSocket 접속 수');
  metrics.declare('skala_rooms', 'gauge', '열린 방 수');
  metrics.declare('skala_players', 'gauge', '방에 들어간 사람 수');
  metrics.declare('skala_messages_in_per_second', 'gauge', '지난 통계 창의 초당 받은 메시지(검사 통과)');
  metrics.declare('skala_messages_out_per_second', 'gauge', '지난 통계 창의 초당 보낸 메시지');
  metrics.declare('skala_tick_max_ms', 'gauge', '지난 통계 창에서 가장 오래 걸린 틱(ms, 모든 방)');
  metrics.declare('skala_ticks_total', 'counter', '돈 서버 틱 수');
  metrics.declare('skala_ticks_skipped_total', 'counter', '서버가 밀려 건너뛴 틱 수');
  metrics.declare('skala_messages_in_total', 'counter', '검사를 통과한 받은 메시지(형식별)');
  metrics.declare('skala_messages_dropped_total', 'counter', '버린 받은 메시지(이유별)');
  metrics.declare('skala_messages_out_total', 'counter', '보낸 메시지');
  metrics.declare('skala_bytes_out_total', 'counter', '보낸 바이트');
  metrics.declare('skala_handshake_rejected_total', 'counter', '거절한 WebSocket 업그레이드(이유별)');
  metrics.declare('skala_disconnects_total', 'counter', '서버가 끊은 접속(이유별)');
  metrics.declare('skala_room_errors_total', 'counter', '오류로 닫은 방');
  metrics.declare('skala_tick_ms', 'gauge', '최근 30초 틱 하나(모든 방)의 계산 시간 분위수(ms). q = 0.5, 0.95, max');
  metrics.declare('skala_bytes_out_per_second', 'gauge', '최근 10초의 초당 보낸 바이트');
  metrics.declare('skala_bytes_out_per_player_per_second', 'gauge', '최근 10초의 사람 한 명당 초당 보낸 바이트');
  metrics.declare('skala_process_cpu_percent', 'gauge', '프로세스 CPU 사용률(한 코어 = 100)');
  metrics.declare('skala_process_rss_bytes', 'gauge', '프로세스 상주 메모리(바이트)');
  metrics.declare('skala_process_heap_used_bytes', 'gauge', 'V8 힙 사용량(바이트)');
  metrics.histogram('skala_tick_duration_ms', '모든 방의 틱 하나를 계산한 시간(ms)', [0.25, 0.5, 1, 2, 5, 10, 20, 33]);

  const ipTag = (ip) => createHash('sha256').update(ipSalt).update(String(ip)).digest('hex').slice(0, 12);
  /** 요청 대상의 경로. 'http://[' 같은 깨진 대상에서 new URL이 던져 프로세스가 멈추지 않게 null로 돌려준다 */
  function pathOf(target) {
    try { return new URL(target, 'http://local').pathname; } catch { return null; }
  }
  function roomWinOf(id) {
    let w = roomWin.get(id);
    if (!w) { w = emptyWindow(); roomWin.set(id, w); }
    return w;
  }

  // ── HTTP ──────────────────────────────────────────────
  function playerCount() {
    let n = 0;
    for (const r of rooms.values()) n += r.size;
    return n;
  }
  /** 최근 값(틱 분위수·초당 바이트·CPU·메모리). /healthz의 live와 /metrics가 같은 값을 쓴다 */
  function live() {
    const t = tickSamples.summary();
    const players = playerCount();
    const bps = rate.perSec('bytesOut');
    const p = proc.read();
    return {
      tickMs: { p50: round3(t.p50), p95: round3(t.p95), max: round3(t.max), n: t.n },
      bytesOutPerSec: Math.round(bps), bytesOutPerPlayerPerSec: players ? Math.round(bps / players) : 0,
      msgOutPerSec: round1(rate.perSec('msgOut')), msgInPerSec: round1(rate.perSec('msgIn')),
      // CPU는 최근 10초 평균(1초 값은 흔들린다). 한 코어 = 100
      cpuPercent: round1(rate.perSec('cpuUs') / 1e4), cpuLastSecPercent: round1(p.cpuPercent), rssMb: round1(p.rssBytes / 1048576), heapMb: round1(p.heapUsedBytes / 1048576)
    };
  }
  function stats() {
    return {
      ok: !closing, version: SERVER_VERSION, protocol: PROTOCOL, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      hz: cfg.hz, ticks: loop.ticks, rooms: rooms.size, players: playerCount(), connections: conns.size, live: live(), window: lastWindow,
      results: poster.stats()
    };
  }
  function onHttp(req, res) {
    const path = pathOf(req.url);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(closing ? 503 : 200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(stats()));
      return;
    }
    if (req.method === 'GET' && path === '/metrics') {
      metrics.set('skala_connections', null, conns.size);
      metrics.set('skala_rooms', null, rooms.size);
      metrics.set('skala_players', null, playerCount());
      const l = live();
      metrics.set('skala_tick_ms', { q: '0.5' }, l.tickMs.p50);
      metrics.set('skala_tick_ms', { q: '0.95' }, l.tickMs.p95);
      metrics.set('skala_tick_ms', { q: 'max' }, l.tickMs.max);
      metrics.set('skala_bytes_out_per_second', null, l.bytesOutPerSec);
      metrics.set('skala_bytes_out_per_player_per_second', null, l.bytesOutPerPlayerPerSec);
      metrics.set('skala_process_cpu_percent', null, l.cpuPercent);
      metrics.set('skala_process_rss_bytes', null, Math.round(l.rssMb * 1048576));
      metrics.set('skala_process_heap_used_bytes', null, Math.round(l.heapMb * 1048576));
      res.writeHead(200, { ...headers, 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.render());
      return;
    }
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  }

  // ── 업그레이드 ────────────────────────────────────────
  const httpServer = http.createServer(onHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes, perMessageDeflate: false, clientTracking: false });

  function clientIp(req) {
    let ip = req.socket.remoteAddress || '';
    if (cfg.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.trim()) ip = fwd.split(',')[0].trim();
    }
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }
  function refuse(socket, status, text, reason) {
    metrics.inc('skala_handshake_rejected_total', { reason });
    socket.once('finish', () => socket.destroy());   // 응답을 다 내보낸 뒤 닫는다
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});   // 업그레이드 전에 끊긴 소켓의 오류가 프로세스를 멈추지 않게
    const path = pathOf(req.url);
    if (closing) return refuse(socket, 503, 'Service Unavailable', 'closing');
    if (path === null) return refuse(socket, 400, 'Bad Request', 'bad_target');
    const roomId = roomIdFromPath(path);
    if (!roomId) return refuse(socket, 404, 'Not Found', 'path');
    // Origin은 다른 사이트의 페이지가 붙는 것을 막는다. 값이 없는 요청(봇·부하 시험 같은 브라우저 밖 프로그램)은 어차피 값을 꾸밀 수 있어 막지 않는다
    const origin = req.headers.origin;
    if (cfg.allowedOrigins.length && origin && !cfg.allowedOrigins.includes(origin)) return refuse(socket, 403, 'Forbidden', 'origin');
    if (conns.size >= cfg.maxConnections) return refuse(socket, 503, 'Service Unavailable', 'capacity');
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= cfg.maxPerIp) return refuse(socket, 429, 'Too Many Requests', 'per_ip');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, roomId));
  });

  // ── 접속 ──────────────────────────────────────────────
  function sendTo(conn, text) {
    const ws = conn.ws;
    if (conn.closed || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > cfg.maxBufferedBytes) { drop(conn, CLOSE.SLOW, 'slow_consumer'); return; }
    ws.send(text);
    const bytes = Buffer.byteLength(text);
    metrics.inc('skala_messages_out_total');
    metrics.inc('skala_bytes_out_total', null, bytes);
    win.msgOut++;
    win.bytesOut += bytes;
    totals.msgOut++;
    totals.bytesOut += bytes;
    if (conn.room) { const rw = roomWinOf(conn.room.id); rw.msgOut++; rw.bytesOut += bytes; }
  }

  /** 방에서 빼고 접속 목록에서 지운다. 여러 번 불려도 한 번만 한다 */
  function detach(conn, reason) {
    if (conn.detached) return;
    conn.detached = true;
    conn.closed = true;
    clearTimeout(conn.joinTimer);
    conns.delete(conn);
    const n = (perIp.get(conn.ip) || 1) - 1;
    if (n > 0) perIp.set(conn.ip, n); else perIp.delete(conn.ip);
    if (conn.room && conn.playerId) conn.room.leave(conn.playerId, reason);
    if (conn.playerId) byPlayer.delete(conn.playerId);
    conn.room = null;
  }

  /** 이유를 보내고 닫는다. 방에서 빼는 일은 지금 돌고 있는 틱이 끝난 뒤에 한다(틱 도중에 사람 목록이 바뀌지 않게) */
  function drop(conn, code, reason, message = '', text = null) {
    if (conn.closed) return;
    conn.closed = true;
    clearTimeout(conn.joinTimer);
    metrics.inc('skala_disconnects_total', { reason });
    try {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(text || encodeError(reason, message));
        conn.ws.close(code, reason);
      }
    } catch { /* 이미 닫히는 중 */ }
    queueMicrotask(() => detach(conn, reason));
    // 닫기 인사에 답하지 않는 상대는 잠시 뒤 끊는다
    setTimeout(() => conn.ws.terminate(), 2000).unref();
  }

  function strike(conn, points, reason) {
    metrics.inc('skala_messages_dropped_total', { reason });
    if (conn.strikes.add(points, reason)) {
      log.warn({ conn: conn.id, room: conn.roomId, player: conn.playerId, ip: ipTag(conn.ip), reasons: conn.strikes.reasons() }, 'closing abusive connection');
      drop(conn, CLOSE.POLICY, 'policy');
    }
  }

  function onConnection(ws, ip, roomId) {
    const conn = {
      id: ++connSeq, ws, ip, roomId, room: null, playerId: null, rtt: null, pingAt: 0, waitingPong: false, closed: false, detached: false,
      bucket: new TokenBucket(cfg.msgRate, cfg.msgBurst), strikes: createStrikes({ limit: cfg.strikeLimit }),
      joinTimer: null
    };
    conns.add(conn);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    conn.joinTimer = setTimeout(() => drop(conn, CLOSE.JOIN_TIMEOUT, 'join_timeout'), cfg.joinTimeoutMs);
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (err) {
        log.error({ err, conn: conn.id, room: conn.roomId, player: conn.playerId }, 'message handling failed');
        drop(conn, CLOSE.ROOM_ERROR, 'internal_error');
      }
    });
    ws.on('pong', () => { conn.waitingPong = false; conn.rtt = performance.now() - conn.pingAt; });
    ws.on('close', (code) => detach(conn, `closed_${code}`));
    ws.on('error', (err) => log.debug({ conn: conn.id, err }, 'socket error'));
    log.debug({ conn: conn.id, room: roomId, ip: ipTag(ip) }, 'connected');
  }

  function ping(conn) {
    conn.waitingPong = true;
    conn.pingAt = performance.now();
    try { conn.ws.ping(); } catch { /* 닫히는 중 */ }
  }

  function onMessage(conn, data, isBinary) {
    if (conn.closed) return;
    if (isBinary) return strike(conn, 1, 'binary');
    if (data.length > cfg.maxMessageBytes) return strike(conn, 2, 'too_big');
    if (!conn.bucket.take()) return strike(conn, 1, 'rate');
    const res = decodeClient(data.toString('utf8'));
    // 모르는 형식은 버리기만 한다(새 클라이언트가 옛 서버에 붙어도 바로 끊기지 않게). 쏟아부으면 점수가 쌓인다
    if (!res.ok) return strike(conn, res.reason === 'unknown_type' ? 0.25 : 1, res.reason);
    const msg = res.msg;
    metrics.inc('skala_messages_in_total', { type: msg.t });
    win.msgIn++;
    totals.msgIn++;
    if (msg.t === 'join') return onJoin(conn, msg);
    if (!conn.room) return strike(conn, 1, 'not_joined');
    roomWinOf(conn.room.id).msgIn++;
    conn.room.input(conn.playerId, msg);
  }

  function roomOptions(opts) {
    return {
      map: opts.map && MAP_CHOICES.includes(opts.map) ? opts.map : cfg.defaultMap,
      mode: opts.mode || cfg.defaultMode,
      ruleset: opts.ruleset && RULESET_IDS.includes(opts.ruleset) ? opts.ruleset : cfg.defaultRuleset,
      killTarget: opts.killTarget ?? cfg.defaultKillTarget
    };
  }

  function onJoin(conn, msg) {
    if (conn.room) return strike(conn, 1, 'double_join');
    // 판이 다르면 이유(새로고침 필요)를 보내고 끊는다. 옛 클라이언트가 모르는 메시지를 받고 엉뚱하게 움직이지 않게 방에는 넣지 않는다
    if (msg.v !== PROTOCOL) return drop(conn, CLOSE.BAD_VERSION, 'bad_version', '', encodeVersionError(msg.v));
    const roomId = conn.roomId;
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= cfg.maxRooms) return drop(conn, CLOSE.SERVER_FULL, 'server_full');
      // 한 IP가 1인 방을 잔뜩 만들어 방 수 상한을 채우지 못하게 한다
      if ((roomsByIp.get(conn.ip) || 0) >= cfg.maxRoomsPerIp) return drop(conn, CLOSE.SERVER_FULL, 'too_many_rooms');
      const opts = roomOptions(msg.opts);
      room = createRoom({
        send: (pid, text) => { const c = byPlayer.get(pid); if (c) sendTo(c, text); },
        rttOf: (pid) => { const c = byPlayer.get(pid); return c ? c.rtt : null; },
        id: roomId, ...opts, hz: cfg.hz, substeps: cfg.substeps, roomSize: opts.mode === 'ffa' ? cfg.ffaRoomSize : cfg.roomSize, maxRewindMs: cfg.maxRewindMs,
        historyTicks: cfg.historyTicks, snapshotEvery: cfg.snapshotEvery, matchEvery: cfg.matchEvery, rules: cfg.matchRules,
        rng: mulberry32(Math.floor(master() * 0xffffffff)), log, onEmpty: () => closeRoom(roomId, 'empty'),
        // 개인전 경기 끝의 결과 → 서명해서 API로(꺼져 있으면 버린다). 서버가 경기 중에 꺼지면 결과가 없다 = 그 경기는 무효
        resultRoomId: `${roomId}-${bootId}-${++roomSerial}`, serverId,
        onResult: poster.enabled ? (result) => poster.post(result) : null
      });
      room.creatorIp = conn.ip;
      roomsByIp.set(conn.ip, (roomsByIp.get(conn.ip) || 0) + 1);
      rooms.set(roomId, room);
      log.info({ room: roomId, ...opts, by: ipTag(conn.ip) }, 'room created');
    }
    const playerId = `p${++playerSeq}`;   // 신원은 서버가 정한다
    byPlayer.set(playerId, conn);         // join 안에서 보내는 welcome이 닿게 먼저 잇는다
    conn.room = room;
    conn.playerId = playerId;
    const r = room.join(playerId, { name: msg.name, team: msg.team, tokenHash: msg.tokenHash });
    if (!r.ok) {
      byPlayer.delete(playerId);
      conn.room = null;
      conn.playerId = null;
      if (!room.size) closeRoom(room.id, 'empty');
      return drop(conn, r.code === 'room_full' ? CLOSE.ROOM_FULL : CLOSE.BAD_JOIN, r.code);
    }
    clearTimeout(conn.joinTimer);
    ping(conn);   // 첫 왕복 시간을 바로 잰다
  }

  function closeRoom(id, reason) {
    const room = rooms.get(id);
    if (!room) return;
    rooms.delete(id);
    roomWin.delete(id);
    const n = (roomsByIp.get(room.creatorIp) || 1) - 1;
    if (n > 0) roomsByIp.set(room.creatorIp, n); else roomsByIp.delete(room.creatorIp);
    for (const conn of conns) if (conn.room === room) drop(conn, CLOSE.ROOM_ERROR, reason);
    room.dispose();
    log.info({ room: id, reason, ...room.stats() }, 'room closed');
  }

  // ── 루프 ──────────────────────────────────────────────
  function tickAll() {
    const t0 = performance.now();
    for (const room of rooms.values()) {
      const r0 = performance.now();
      try {
        room.tick();
      } catch (err) {
        metrics.inc('skala_room_errors_total');
        log.error({ err, room: room.id }, 'room tick failed; closing room');
        closeRoom(room.id, 'room_error');
        continue;
      }
      const ms = performance.now() - r0;
      const rw = roomWinOf(room.id);
      rw.tickMs += ms;
      rw.ticks++;
      if (ms > rw.tickMax) rw.tickMax = ms;
    }
    const ms = performance.now() - t0;
    metrics.observe('skala_tick_duration_ms', ms);
    tickSamples.add(ms);
    metrics.inc('skala_ticks_total');
    win.tickMs += ms;
    win.ticks++;
    if (ms > win.tickMax) win.tickMax = ms;
  }

  /** 통계 창 하나를 로그(서버 한 줄 + 방마다 한 줄)와 지표로 내고 비운다 */
  function reportStats() {
    const sec = Math.max(0.001, (performance.now() - win.start) / 1000);
    const perSec = (n) => round1(n / sec);
    lastWindow = {
      sec: round1(sec), rooms: rooms.size, players: playerCount(), connections: conns.size,
      tickMsAvg: win.ticks ? round3(win.tickMs / win.ticks) : 0, tickMsMax: round3(win.tickMax),
      msgInPerSec: perSec(win.msgIn), msgOutPerSec: perSec(win.msgOut), kbOutPerSec: perSec(win.bytesOut / 1024)
    };
    metrics.set('skala_messages_in_per_second', null, lastWindow.msgInPerSec);
    metrics.set('skala_messages_out_per_second', null, lastWindow.msgOutPerSec);
    metrics.set('skala_tick_max_ms', null, lastWindow.tickMsMax);
    log.info(lastWindow, 'server stats');
    for (const room of rooms.values()) {
      const rw = roomWin.get(room.id) || emptyWindow();
      log.info({
        room: room.id, players: room.size, phase: room.phase, tick: room.currentTick,
        tickMsAvg: rw.ticks ? round3(rw.tickMs / rw.ticks) : 0, tickMsMax: round3(rw.tickMax),
        msgInPerSec: perSec(rw.msgIn), msgOutPerSec: perSec(rw.msgOut), kbOutPerSec: perSec(rw.bytesOut / 1024),
        avgRewindMs: room.stats().avgRewindMs
      }, 'room stats');
    }
    win = { ...emptyWindow(), start: performance.now() };
    roomWin = new Map();
  }

  const loop = createLoop({
    hz: cfg.hz,
    step: tickAll,
    onLag: (behindMs, skipped) => {
      metrics.inc('skala_ticks_skipped_total', null, skipped);
      log.warn({ behindMs: Math.round(behindMs), skipped }, 'tick loop fell behind');
    }
  });
  // ping을 보내고 이만큼 지나도 pong이 없으면 죽은 접속이다. join 직후의 ping이 다음 박동 직전에 나갔을 수 있어 박동마다 바로 끊지 않는다
  const pongDeadlineMs = cfg.pingIntervalMs * 0.8;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    for (const conn of conns) {
      if (conn.closed) continue;
      if (conn.waitingPong) {
        if (now - conn.pingAt > pongDeadlineMs) { metrics.inc('skala_disconnects_total', { reason: 'no_pong' }); conn.ws.terminate(); }
        continue;
      }
      ping(conn);
    }
  }, cfg.pingIntervalMs);
  const statsTimer = setInterval(reportStats, cfg.statsIntervalMs);
  const markRate = () => { totals.cpuUs = cpuNow() - cpuStart; rate.mark(totals); };
  markRate();
  const sampleTimer = setInterval(() => { markRate(); proc.sample(); }, 1000);
  sampleTimer.unref();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(cfg.port, cfg.host, () => { httpServer.off('error', reject); resolve(); });
  });
  const port = httpServer.address().port;
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  loop.start();
  log.info({ host: cfg.host, port, hz: cfg.hz, roomSize: cfg.roomSize, maxRewindMs: cfg.maxRewindMs, version: SERVER_VERSION }, 'server listening');

  async function close() {
    if (closing) return;
    closing = true;
    loop.stop();
    clearInterval(heartbeat);
    clearInterval(statsTimer);
    clearInterval(sampleTimer);
    const open = [...conns];
    for (const conn of open) drop(conn, CLOSE.GOING_AWAY, 'server_shutdown');
    // 닫기 인사를 잠깐 기다렸다가 남은 소켓은 끊는다
    await new Promise((r) => setTimeout(r, open.length ? 200 : 0));
    for (const conn of open) conn.ws.terminate();
    for (const id of [...rooms.keys()]) closeRoom(id, 'server_shutdown');
    // 이미 끝난 경기의 결과는 잠깐 더 보내 본다. 그래도 남으면 로그만 남기고 버린다
    if (poster.pending) await Promise.race([poster.idle(), new Promise((r) => setTimeout(r, cfg.resultFlushMs).unref())]);
    poster.close();
    await new Promise((r) => {
      httpServer.close(() => r());
      httpServer.closeAllConnections();
    });
    log.info(stats(), 'server closed');
  }

  const url = `ws://${host}:${port}`;
  return { url, roomUrl: (id) => `${url}/room/${id}`, httpUrl: `http://${host}:${port}`, port, close, stats, metrics, rooms, config: cfg, results: poster };
}
