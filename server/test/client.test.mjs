/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 브라우저용 게임 서버 클라이언트(js/net/gameserver.js)를 실제 서버에 붙이는 시험. welcome·입력 ack·즉시 부활 거절이 오고,
 *          버전이 다르면 RELOAD(새로고침 필요) 오류로 끝나는 것을 본다. ws 패키지의 WebSocket을 브라우저 대신 넣는다.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { ROW, connectGameServer } from '../../js/net/gameserver.js';
import { startTestServer, until } from './helpers.mjs';

describe('브라우저 클라이언트 → 게임 서버', () => {
  let server;
  before(async () => { server = await startTestServer(); });
  after(async () => { await server.close(); });

  test('붙어서 welcome, 입력을 보내면 내 줄 ack가 따라오고, 팀전의 respawn은 거절이 온다', async () => {
    const gs = await connectGameServer({ url: server.url, room: 'web1', name: '하늘', WebSocket });
    assert.match(gs.playerId, /^p\d+$/);
    assert.equal(gs.welcome.room, 'web1');
    let ack = -1;
    const rejects = [];
    gs.on('snap', (m) => { const r = m.players.find((x) => x[ROW.ID] === gs.playerId); if (r) ack = r[ROW.ACK]; });
    gs.on('events', (m) => { for (const e of m.events) if (e.type === 'reject') rejects.push(e); });
    for (let i = 0; i < 3; i++) gs.sendInput({ keys: 0, yaw: 0, pitch: 0 });
    gs.respawn();
    await until(() => ack === 2 && rejects.length, 3000, 'ack 2 + reject');
    assert.equal(rejects[0].reason, 'not_ffa');
    gs.close();
  });

  test('개인전 방을 만들면 welcome에 목표 킬이 온다', async () => {
    const gs = await connectGameServer({ url: server.url, room: 'web2', opts: { mode: 'ffa', killTarget: 10 }, WebSocket });
    assert.equal(gs.welcome.mode, 'ffa');
    assert.equal(gs.welcome.killTarget, 10);
    gs.close();
  });

  test('버전이 다르면 RELOAD 오류(새로고침 필요)로 끝난다', async () => {
    await assert.rejects(connectGameServer({ url: server.url, room: 'web3', version: 1, WebSocket }), (e) => e.code === 'RELOAD' && e.reload === true);
  });
});
