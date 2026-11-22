/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 실제 소켓으로 붙는 Node 어댑터 시험. welcome·스냅샷·ack, /healthz·/metrics, 방별 통계 로그(틱 시간·초당 메시지), 정원 6명, 모르는 형식·큰 메시지·큰 프레임·과속·
 *          join 시간 초과·버전, 깨진 요청 대상, Origin·경로·IP당 제한, ping 기한, 나가면 알림과 빈 방 정리, 한 방의 오류가 다른 방을 멈추지 않는 것을 본다.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import WebSocket from 'ws';

import { CLOSE, PROTOCOL, RELOAD_MESSAGE, ROW } from '../core/protocol.js';
import { createLogger, memoryStream } from '../node/log.js';
import { createFakeClient } from '../tools/fake-client.js';
import { startTestServer, until } from './helpers.mjs';

/** 열릴 때까지. 업그레이드가 거절되면 상태 코드로 reject */
function open(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
  });
}
/** 모든 메시지를 모으는 날 소켓 */
function track(ws) {
  const msgs = [];
  const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* 무시 */ } });
  return { ws, msgs, closed, find: (pred) => msgs.find(pred) };
}
const join = (ws, extra = {}) => ws.send(JSON.stringify({ t: 'join', v: PROTOCOL, name: 'raw', ...extra }));
const input = (ws, seq, extra = {}) => ws.send(JSON.stringify({ t: 'input', seq, keys: 0, yaw: 0, pitch: 0, ...extra }));

describe('기본 서버', () => {
  let server;
  before(async () => { server = await startTestServer(); });
  after(async () => { await server.close(); });

  test('/room/<id>로 join → welcome(서버가 정한 playerId), 입력을 보내면 스냅샷의 내 줄 ack가 따라온다', async () => {
    const c = track(await open(server.roomUrl('basic')));
    join(c.ws, { team: 'owner', playerId: 'spoofed' });
    await until(() => c.find((m) => m.t === 'welcome'), 3000, 'welcome');
    const w = c.find((m) => m.t === 'welcome');
    assert.equal(w.v, PROTOCOL);
    assert.equal(w.team, 'owner');
    assert.equal(w.room, 'basic');
    assert.match(w.playerId, /^p\d+$/, '클라이언트가 보낸 id가 아니라 서버가 정한 id');
    for (let s = 0; s < 3; s++) input(c.ws, s);
    await until(() => c.msgs.some((m) => m.t === 'snap' && m.players.some((r) => r[ROW.ID] === w.playerId && r[ROW.ACK] === 2)), 3000, 'ack 2');
    assert.ok(c.msgs.some((m) => m.t === 'match' && m.leader === w.playerId), '점수판과 방장');
    c.ws.close();
    await c.closed;
  });

  test('/healthz와 /metrics', async () => {
    const c = createFakeClient({ url: server.url, room: 'health', behavior: 'idle' });
    await c.ready;
    const h = await (await fetch(`${server.httpUrl}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.protocol, PROTOCOL);
    assert.ok(h.rooms >= 1 && h.players >= 1 && h.connections >= 1);
    const text = await (await fetch(`${server.httpUrl}/metrics`)).text();
    assert.match(text, /# TYPE skala_tick_duration_ms histogram/);
    assert.match(text, /skala_connections [1-9]/);
    assert.match(text, /skala_messages_in_total\{type="join"\} [1-9]/);
    assert.match(text, /# TYPE skala_messages_in_per_second gauge/);
    assert.match(text, /skala_tick_ms\{q="0.95"\} [0-9.]+/);
    assert.match(text, /skala_tick_ms\{q="max"\} [0-9.]+/);
    assert.match(text, /skala_bytes_out_per_second [0-9]+/);
    assert.match(text, /skala_bytes_out_per_player_per_second [0-9]+/);
    assert.match(text, /skala_process_rss_bytes [1-9][0-9]*/);
    assert.ok(h.live && h.live.tickMs.n > 0 && h.live.tickMs.p95 >= h.live.tickMs.p50 && h.live.tickMs.max >= h.live.tickMs.p95, 'healthz.live 틱 분위수');
    assert.ok(h.live.rssMb > 0);
    assert.equal((await fetch(`${server.httpUrl}/nope`)).status, 404);
    await c.close();
  });

  test('정원 6명: 7번째는 room_full(4001)로 끊긴다', async () => {
    const six = [];
    for (let i = 0; i < 6; i++) {
      const c = createFakeClient({ url: server.url, room: 'full', name: `p${i}`, behavior: 'idle' });
      await c.ready;
      six.push(c);
    }
    const late = track(await open(server.roomUrl('full')));
    join(late.ws);
    const closed = await late.closed;
    assert.equal(closed.code, CLOSE.ROOM_FULL);
    assert.equal(late.find((m) => m.t === 'error').code, 'room_full');
    assert.equal(server.rooms.get('full').size, 6);
    await Promise.all(six.map((c) => c.close()));
  });

  test('모르는 형식과 큰 메시지는 버리기만 하고 접속은 이어진다', async () => {
    const c = track(await open(server.roomUrl('junk')));
    join(c.ws);
    await until(() => c.find((m) => m.t === 'welcome'), 3000, 'welcome');
    const id = c.find((m) => m.t === 'welcome').playerId;
    c.ws.send(JSON.stringify({ t: 'chat', text: 'hi' }));
    c.ws.send(JSON.stringify({ t: 'input', seq: 0, yaw: 0, pitch: 0, pad: 'x'.repeat(600) }));   // 512 B 초과
    c.ws.send('{not json');
    input(c.ws, 1);
    await until(() => c.msgs.some((m) => m.t === 'snap' && m.players.some((r) => r[ROW.ID] === id && r[ROW.ACK] === 1)), 3000, 'ack 1');
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    const text = await (await fetch(`${server.httpUrl}/metrics`)).text();
    for (const reason of ['unknown_type', 'too_big', 'bad_json']) assert.match(text, new RegExp(`skala_messages_dropped_total\\{reason="${reason}"\\} [1-9]`));
    c.ws.close();
    await c.closed;
  });

  test('maxFrameBytes(4 KB)보다 큰 프레임은 1009로 끊긴다', async () => {
    const c = track(await open(server.roomUrl('big')));
    c.ws.send('x'.repeat(5000));
    assert.equal((await c.closed).code, CLOSE.TOO_BIG);
  });

  test('메시지를 쏟아부으면 속도 제한에 걸려 1008로 끊긴다', async () => {
    const c = track(await open(server.roomUrl('flood')));
    join(c.ws);
    await until(() => c.find((m) => m.t === 'welcome'), 3000, 'welcome');
    for (let s = 0; s < 400; s++) input(c.ws, s);
    const closed = await c.closed;
    assert.equal(closed.code, CLOSE.POLICY);
    assert.equal(c.find((m) => m.t === 'error').code, 'policy');
  });

  test('버전이 다르면 bad_version(4002): 새로고침 안내와 서버 판을 보내고 방은 만들지 않는다', async () => {
    const c = track(await open(server.roomUrl('v')));
    c.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL - 1 }));
    assert.equal((await c.closed).code, CLOSE.BAD_VERSION);
    const e = c.find((m) => m.t === 'error');
    assert.equal(e.code, 'bad_version');
    assert.equal(e.reload, true);
    assert.equal(e.message, RELOAD_MESSAGE);
    assert.equal(e.server, PROTOCOL);
    assert.equal(e.client, PROTOCOL - 1);
    assert.equal(server.rooms.has('v'), false);
    const fake = createFakeClient({ url: server.url, room: 'v2', behavior: 'idle', version: 1 });
    await assert.rejects(fake.ready);
    assert.equal(fake.error.reload, true, '가짜 클라이언트도 이유를 받는다');
    await fake.close();
  });

  test('나가면 남은 사람에게 leave가 가고, 빈 방은 지운다', async () => {
    const a = createFakeClient({ url: server.url, room: 'bye', name: 'a', behavior: 'idle' });
    await a.ready;
    const b = createFakeClient({ url: server.url, room: 'bye', name: 'b', behavior: 'idle' });
    await b.ready;
    const bid = b.id;
    await b.close();
    await a.waitFor((c) => c.events.some((e) => e.type === 'leave' && e.id === bid), 3000, 'leave');
    await a.close();
    await until(() => !server.rooms.has('bye'), 3000, '빈 방 정리');
  });

  test('URL로 읽을 수 없는 요청 대상(http://[)에도 서버가 멈추지 않는다', async () => {
    const port = new URL(server.httpUrl).port;
    /** 날 TCP로 요청 한 줄을 보내고 첫 응답 줄을 받는다 */
    const raw = (text) => new Promise((resolve, reject) => {
      const s = connect(Number(port), '127.0.0.1', () => s.write(text));
      let buf = '';
      s.on('data', (d) => { buf += d.toString(); });
      s.on('end', () => resolve(buf.split('\r\n')[0]));
      s.on('error', reject);
      s.setTimeout(3000, () => { s.destroy(); resolve(buf.split('\r\n')[0]); });
    });
    const upgrade = 'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';
    assert.match(await raw(upgrade), /^HTTP\/1\.1 400/);
    assert.match(await raw('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 404/);
    const h = await (await fetch(`${server.httpUrl}/healthz`)).json();
    assert.equal(h.ok, true, '살아 있다');
  });

  test('한 방이 틱 중에 던지면 그 방만 닫고(4007) 다른 방은 계속 돈다', async () => {
    const bad = createFakeClient({ url: server.url, room: 'broken', behavior: 'idle' });
    const good = createFakeClient({ url: server.url, room: 'healthy', behavior: 'idle' });
    await Promise.all([bad.ready, good.ready]);
    server.rooms.get('broken').tick = () => { throw new Error('boom'); };
    const closed = await bad.closed;
    assert.equal(closed.code, CLOSE.ROOM_ERROR);
    assert.ok(!server.rooms.has('broken'));
    const k = good.latestTick;
    await good.waitFor((c) => c.latestTick > k + 5, 3000, '다른 방은 계속 스냅샷');
    const text = await (await fetch(`${server.httpUrl}/metrics`)).text();
    assert.match(text, /skala_room_errors_total 1/);
    await good.close();
  });
});

describe('통계 로그', () => {
  test('통계 창마다 서버 한 줄 + 방마다 한 줄(방 id·사람 수·틱 시간·초당 메시지), /healthz와 지표에도 싣는다', async () => {
    const out = memoryStream();
    const server = await startTestServer({ statsIntervalMs: 300, log: createLogger({ level: 'info', stream: out }) });
    const c = createFakeClient({ url: server.url, room: 'stats', behavior: 'idle' });
    try {
      await c.ready;
      await until(() => out.lines().some((l) => l.msg === 'room stats' && l.room === 'stats' && l.msgInPerSec > 0), 3000, 'room stats');
      const joined = out.lines().find((l) => l.msg === 'player joined');
      assert.equal(joined.room, 'stats');
      assert.equal(joined.player, c.id, '입장 줄에 방 id와 플레이어 id');
      const room = out.lines().filter((l) => l.msg === 'room stats' && l.room === 'stats').at(-1);
      assert.equal(room.players, 1);
      assert.ok(room.tickMsAvg > 0 && room.tickMsMax >= room.tickMsAvg, JSON.stringify(room));
      assert.ok(room.msgOutPerSec >= 25, `틱마다 스냅샷: ${room.msgOutPerSec}/s`);
      const srv = out.lines().filter((l) => l.msg === 'server stats').at(-1);
      assert.ok(srv.rooms >= 1 && srv.connections >= 1 && srv.tickMsAvg > 0, JSON.stringify(srv));
      const h = await (await fetch(`${server.httpUrl}/healthz`)).json();
      assert.ok(h.window && h.window.msgOutPerSec > 0, JSON.stringify(h.window));
      const text = await (await fetch(`${server.httpUrl}/metrics`)).text();
      assert.match(text, /skala_messages_out_per_second [1-9]/);
    } finally {
      await c.close();
      await server.close();
    }
  });
});

describe('접속 제한 설정', () => {
  test('join 없이 joinTimeoutMs가 지나면 4003', async () => {
    const server = await startTestServer({ joinTimeoutMs: 150 });
    try {
      const c = track(await open(server.roomUrl('idle')));
      const t0 = performance.now();
      assert.equal((await c.closed).code, CLOSE.JOIN_TIMEOUT);
      assert.ok(performance.now() - t0 < 2000);
    } finally { await server.close(); }
  });

  test('pong이 늦어도 기한 안이면 붙어 있고, 끝내 답하지 않으면 끊는다', async () => {
    const server = await startTestServer({ pingIntervalMs: 200 });
    try {
      // 왕복 120 ms인 사람: ping에 늦게 답한다
      const slow = track(await open(server.roomUrl('hb'), { autoPong: false }));
      slow.ws.on('ping', () => setTimeout(() => { if (slow.ws.readyState === WebSocket.OPEN) slow.ws.pong(); }, 120));
      join(slow.ws, { name: 'slow' });
      // 아예 답하지 않는 사람
      const dead = track(await open(server.roomUrl('hb'), { autoPong: false }));
      join(dead.ws, { name: 'dead' });
      await until(() => dead.ws.readyState === WebSocket.CLOSED, 3000, '답 없는 접속 끊김');
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(slow.ws.readyState, WebSocket.OPEN, '1초(박동 5번) 동안 늦은 답으로 버틴다');
      const m = [...slow.msgs].reverse().find((x) => x.t === 'match');
      const rtt = Object.values(m.ping).find((v) => v != null);
      assert.ok(rtt >= 100, `잰 왕복 ${rtt} ms`);
      slow.ws.close();
    } finally { await server.close(); }
  });

  test('다른 사이트의 Origin은 403, 허용한 Origin과 Origin 없는 브라우저 밖 클라이언트는 붙는다', async () => {
    const server = await startTestServer({ allowedOrigins: ['https://good.example'] });
    try {
      await assert.rejects(open(server.roomUrl('o'), { origin: 'https://evil.example' }), (e) => e.status === 403);
      const good = await open(server.roomUrl('o'), { origin: 'https://good.example' });
      const bot = await open(server.roomUrl('o'));   // 봇·부하 시험(값을 꾸밀 수 있어 막아도 소용없다)
      good.close(); bot.close();
    } finally { await server.close(); }
  });

  test('방 주소가 아니면 404, IP당 접속 수를 넘으면 429', async () => {
    const server = await startTestServer({ maxPerIp: 2 });
    try {
      await assert.rejects(open(`${server.url}/other`), (e) => e.status === 404);
      await assert.rejects(open(server.roomUrl('BAD')), (e) => e.status === 404, '대문자 방 id');
      await assert.rejects(open(server.roomUrl('a'.repeat(17))), (e) => e.status === 404, '17자');
      const a = await open(server.roomUrl('x')), b = await open(server.roomUrl('x'));
      await assert.rejects(open(server.roomUrl('x')), (e) => e.status === 429);
      a.close();
      await until(() => server.stats().connections === 1, 3000, '하나 닫힘');
      const c = await open(server.roomUrl('x'));
      b.close(); c.close();
    } finally { await server.close(); }
  });

  test('한 IP가 만든 열린 방 수를 넘으면 too_many_rooms(4004), 남이 만든 방에는 들어간다', async () => {
    const server = await startTestServer({ maxRoomsPerIp: 2 });
    try {
      const a = createFakeClient({ url: server.url, room: 'r1', behavior: 'idle' });
      const b = createFakeClient({ url: server.url, room: 'r2', behavior: 'idle' });
      await Promise.all([a.ready, b.ready]);
      const c = track(await open(server.roomUrl('r3')));
      join(c.ws);
      assert.equal((await c.closed).code, CLOSE.SERVER_FULL);
      assert.equal(c.find((m) => m.t === 'error').code, 'too_many_rooms');
      const d = createFakeClient({ url: server.url, room: 'r1', behavior: 'idle' });
      await d.ready;   // 이미 있는 방에 들어가는 것은 만드는 것이 아니다
      await a.close(); await d.close();
      await until(() => !server.rooms.has('r1'), 3000, 'r1 닫힘');
      const e = createFakeClient({ url: server.url, room: 'r3', behavior: 'idle' });
      await e.ready;   // 방이 닫히면 다시 만들 수 있다
      await b.close(); await e.close();
    } finally { await server.close(); }
  });

  test('닫으면 남은 접속에 server_shutdown(1001)을 보낸다', async () => {
    const server = await startTestServer();
    const c = track(await open(server.roomUrl('shutdown')));
    join(c.ws);
    await until(() => c.find((m) => m.t === 'welcome'), 3000, 'welcome');
    await server.close();
    assert.equal((await c.closed).code, CLOSE.GOING_AWAY);
    assert.equal(c.find((m) => m.t === 'error').code, 'server_shutdown');
  });
});
