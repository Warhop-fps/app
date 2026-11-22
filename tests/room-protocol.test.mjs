/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 공통 부품 시험(server/core). 메시지 검사(decodeClient)·방 주소·이름 정리·스냅샷 줄, 토큰 버킷·위반 점수를 본다. 소켓 없이 npm test에서 돈다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_TYPES, KEY_MASK, MAX_SEQ, PRESS_MASK, PROTOCOL, RELOAD_MESSAGE, ROW, cleanName, decodeClient, decodeRow, encodeRow, encodeVersionError, roomIdFromPath
} from '../server/core/protocol.js';
import { TokenBucket, createStrikes } from '../server/core/limits.js';

const enc = (o) => JSON.stringify(o);

describe('decodeClient', () => {
  test('join: 이름을 정리하고 모르는 팀·옵션은 버린다(방 id는 주소가 정한다)', () => {
    const r = decodeClient(enc({ t: 'join', v: PROTOCOL, room: 'ignored', name: '  철수‮\u0007 ', team: 'blue', opts: { map: 'arena', mode: 'ffa', ruleset: 'knife', x: 1 } }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.msg, { t: 'join', v: PROTOCOL, name: '철수', team: null, opts: { map: 'arena', mode: 'ffa', ruleset: 'knife', killTarget: null } });
  });

  test('join: 개인전 목표 킬은 5~20으로 자르고, 숫자가 아니면 없는 것으로 본다', () => {
    const kt = (v) => decodeClient(enc({ t: 'join', v: PROTOCOL, opts: { mode: 'ffa', killTarget: v } })).msg.opts.killTarget;
    assert.equal(kt(10), 10);
    assert.equal(kt(2), 5);
    assert.equal(kt(99), 20);
    assert.equal(kt('15'), 15);
    assert.equal(kt('abc'), null);
    assert.equal(kt({}), null);
  });

  test('respawn은 덧붙은 칸을 버리고 형식만 남긴다', () => {
    assert.deepEqual(decodeClient(enc({ t: 'respawn', id: 'p9' })).msg, { t: 'respawn' });
  });

  test('버전이 다를 때의 오류는 새로고침 안내와 서버 판을 싣는다', () => {
    const e = JSON.parse(encodeVersionError(1));
    assert.deepEqual(e, { t: 'error', code: 'bad_version', message: RELOAD_MESSAGE, reload: true, server: PROTOCOL, client: 1 });
    assert.equal(RELOAD_MESSAGE, '새로고침 필요');
    assert.equal(JSON.parse(encodeVersionError('x')).client, null);
  });

  test('join: 버전은 정수여야 한다(다른 버전은 형식은 맞고 어댑터가 bad_version으로 끊는다)', () => {
    assert.equal(decodeClient(enc({ t: 'join', v: '1' })).ok, false);
    assert.equal(decodeClient(enc({ t: 'join', v: 99 })).ok, true);
  });

  test('input: yaw는 감고 pitch는 ±89°로 자르고 비트는 가린다', () => {
    const r = decodeClient(enc({ t: 'input', seq: 5, keys: 0xffff, yaw: Math.PI * 3, pitch: 5, slot: 2, press: 0xff, viewTick: 120.5 }));
    assert.equal(r.ok, true);
    assert.equal(r.msg.keys, KEY_MASK);
    assert.equal(r.msg.press, PRESS_MASK);
    assert.ok(Math.abs(Math.abs(r.msg.yaw) - Math.PI) < 1e-9);
    assert.ok(Math.abs(r.msg.pitch - (89 * Math.PI) / 180) < 1e-12);
    assert.equal(r.msg.slot, 2);
    assert.equal(r.msg.viewTick, 120.5);
    const bare = decodeClient(enc({ t: 'input', seq: 0, yaw: 0, pitch: 0 }));
    assert.deepEqual(bare.msg, { t: 'input', seq: 0, keys: 0, press: 0, yaw: 0, pitch: 0, slot: 0, viewTick: null });
  });

  test('input: 숫자가 아니거나 범위를 벗어나면 버린다', () => {
    const bad = [
      { t: 'input', seq: -1, yaw: 0, pitch: 0 }, { t: 'input', seq: 1.5, yaw: 0, pitch: 0 }, { t: 'input', seq: MAX_SEQ + 1, yaw: 0, pitch: 0 },
      { t: 'input', seq: 1, yaw: 'x', pitch: 0 }, { t: 'input', seq: 1, yaw: 0 }, { t: 'input', seq: 1, yaw: 1e9, pitch: 0 },
      { t: 'input', seq: 1, yaw: 0, pitch: 0, slot: 5 }, { t: 'input', seq: 1, yaw: 0, pitch: 0, keys: 1.5 }, { t: 'input', seq: 1, yaw: 0, pitch: 0, viewTick: 'x' }
    ];
    for (const m of bad) assert.equal(decodeClient(enc(m)).reason, 'bad_field', JSON.stringify(m));
    // JSON에는 NaN·Infinity가 없다: 1e999는 Infinity로 읽혀 거절된다
    assert.equal(decodeClient('{"t":"input","seq":1,"yaw":1e999,"pitch":0}').reason, 'bad_field');
  });

  test('모르는 형식·깨진 JSON·배열은 이유와 함께 거절', () => {
    assert.equal(decodeClient('{"t":"chat","text":"hi"}').reason, 'unknown_type');
    assert.equal(decodeClient('{"t":"toString"}').reason, 'unknown_type', 'Object.prototype 이름도 형식이 아니다');
    assert.equal(decodeClient('{"t":"__proto__"}').reason, 'unknown_type');
    assert.equal(decodeClient('{"x":1}').reason, 'unknown_type');
    assert.equal(decodeClient('{oops').reason, 'bad_json');
    assert.equal(decodeClient('[1,2]').reason, 'bad_shape');
    assert.equal(decodeClient('null').reason, 'bad_shape');
    assert.deepEqual(CLIENT_TYPES, ['join', 'input', 'pick', 'team', 'start', 'respawn']);
  });

  test('pick·team·start', () => {
    assert.deepEqual(decodeClient(enc({ t: 'pick', weapon: 'sr_bolt' })).msg, { t: 'pick', weapon: 'sr_bolt' });
    assert.equal(decodeClient(enc({ t: 'pick', weapon: 'x'.repeat(25) })).ok, false);
    assert.deepEqual(decodeClient(enc({ t: 'team', team: 'charterer' })).msg, { t: 'team', team: 'charterer' });
    assert.equal(decodeClient(enc({ t: 'team', team: 'red' })).ok, false);
    assert.deepEqual(decodeClient(enc({ t: 'start', extra: 1 })).msg, { t: 'start' });
  });
});

describe('방 주소·이름·스냅샷 줄', () => {
  test('방 주소는 /room/<소문자·숫자 1~16자>', () => {
    assert.equal(roomIdFromPath('/room/abc123'), 'abc123');
    for (const p of ['/room/', '/room/ABC', '/room/a-b', `/room/${'a'.repeat(17)}`, '/room/a/b', '/rooms/a', '/', null]) {
      assert.equal(roomIdFromPath(p), null, String(p));
    }
  });

  test('cleanName은 코드 포인트 단위로 24자에서 자른다', () => {
    const out = cleanName('😀'.repeat(30));
    assert.equal(Array.from(out).length, 24);
    assert.ok(!/[\ud800-\udbff]$/.test(out), '서로게이트 반쪽이 남지 않는다');
    assert.equal(cleanName(12), '');
    assert.equal(cleanName('​﻿'), '');
  });

  test('encodeRow → decodeRow: cm·mrad로 줄였다가 되돌린다', () => {
    const row = encodeRow({ id: 'p1', pos: [1.234, 0.5, -7.891], yaw: 1.2345, pitch: -0.1, flags: 8 | 32, hp: 70, weapon: 'ar_std', ack: 41 });
    assert.equal(row.length, Object.keys(ROW).length);
    const r = decodeRow(row);
    assert.deepEqual(r.pos, [1.23, 0.5, -7.89]);
    assert.equal(r.yaw, 1.235);
    assert.equal(r.alive, true);
    assert.equal(r.crouch, true);
    assert.equal(r.ack, 41);
  });
});

describe('limits', () => {
  test('토큰 버킷: burst만큼 바로, 그 뒤는 초당 rate', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    now += 100;   // 0.1초 = 토큰 1개
    assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    now += 10000;
    for (let i = 0; i < 5; i++) assert.equal(b.take(), true, '오래 쉬어도 burst까지만 찬다');
    assert.equal(b.take(), false);
  });

  test('위반 점수는 시간에 따라 줄고 한도에서 true', () => {
    let now = 0;
    const s = createStrikes({ limit: 5, decayPerSec: 1, now: () => now });
    assert.equal(s.add(3, 'bad_json'), false);
    now += 2000;
    assert.equal(s.score(), 1);
    assert.equal(s.add(3, 'rate'), false);
    assert.equal(s.add(1, 'rate'), true);
    assert.deepEqual(s.reasons(), { bad_json: 1, rate: 2 });
  });
});
