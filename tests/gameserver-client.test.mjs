/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버 클라이언트(js/net/gameserver.js)의 순수 부분 시험. 켜는 조건(설정·주소 깃발, 기본은 꺼짐), 키 비트, 버전 오류 → "새로고침 필요",
 *          'server' 전송이 로비는 중계 서버로 쓰는 것, 서버와 같은 약속(js/net/gameproto.js)을 쓰는 것을 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { KEY, PROTOCOL, gameServerError, gameServerUrl, inputKeys, connectGameServer } from '../js/net/gameserver.js';
import * as serverProto from '../server/core/protocol.js';
import { TRANSPORTS } from '../js/net/index.js';

describe('게임 서버 클라이언트: 켜는 조건', () => {
  test('주소가 없으면 늘 꺼짐, 있어도 transport server나 ?server=1일 때만', () => {
    assert.equal(gameServerUrl({ transport: 'relay', gameServer: { url: '' } }, '?server=1'), '');
    assert.equal(gameServerUrl({ transport: 'server' }, ''), '');
    assert.equal(gameServerUrl({ transport: 'relay', gameServer: { url: 'wss://g.example.com' } }, ''), '');
    assert.equal(gameServerUrl({ transport: 'relay', gameServer: { url: 'wss://g.example.com/' } }, '?server=1'), 'wss://g.example.com');
    assert.equal(gameServerUrl({ transport: 'server', gameServer: { url: 'https://g.example.com' } }, ''), 'wss://g.example.com');
    assert.equal(gameServerUrl({ transport: 'server', gameServer: { url: 'ftp://x' } }, ''), '');
  });

  test('배포 설정(js/config.js)은 지금 그대로: transport relay, 게임 서버 주소 비어 있음', () => {
    const src = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
    assert.match(src, /transport: 'relay'/);
    assert.match(src, /gameServer: \{ url: '' \}/);
  });

  test("'server' 전송은 알려진 값이다(로비·방은 중계 서버로)", () => {
    assert.ok(TRANSPORTS.includes('server'));
  });
});

describe('게임 서버 클라이언트: 약속', () => {
  test('서버와 같은 판·키 비트를 쓴다', () => {
    assert.equal(PROTOCOL, serverProto.PROTOCOL);
    assert.equal(KEY, serverProto.KEY);
    assert.equal(inputKeys({ forward: true, fire: true, aim: true }), KEY.FORWARD | KEY.FIRE | KEY.AIM);
    assert.equal(inputKeys(null), 0);
  });

  test('버전 오류는 RELOAD(새로고침 필요), 다른 오류는 이유 코드를 싣는다', () => {
    const e = gameServerError(JSON.parse(serverProto.encodeVersionError(1)));
    assert.equal(e.code, 'RELOAD');
    assert.equal(e.reload, true);
    assert.match(e.message, /새로고침 필요|Reload needed/);
    assert.equal(gameServerError({ code: 'room_full' }).code, 'ROOM_FULL');
    assert.equal(gameServerError({ code: 'policy' }).server, 'policy');
  });

  test('주소·방 id가 틀리면 붙기 전에 거절', async () => {
    await assert.rejects(connectGameServer({ url: '', room: 'a', WebSocket: class {} }), { code: 'NO_CONFIG' });
    await assert.rejects(connectGameServer({ url: 'ws://x', room: 'BAD!', WebSocket: class {} }), { code: 'BAD_ROOM_ID' });
  });
});
