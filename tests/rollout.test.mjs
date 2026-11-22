/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 방마다 판정 엔진 고르기(js/net/rollout.js) 시험. 주소가 없으면 늘 방장 판정(지금 배포 그대로), 서버가 닿지 않거나 끄면 방장 판정,
 *          비율대로 주사위, 주소 깃발(?server=0/1)을 본다. 가짜 fetch만 쓴다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chooseEngine, fetchRollout, gameServerBase, gameServerWs, lastChoice } from '../js/net/rollout.js';

const CFG = Object.freeze({ transport: 'relay', gameServer: { url: 'wss://game.example.com/' } });
const answer = (body, ok = true) => async (url) => {
  answer.last = url;
  return { ok, json: async () => body };
};

describe('판정 엔진 고르기', () => {
  test('바탕 주소: ws → http, 끝의 / 제거, 비거나 틀리면 빈 값', () => {
    assert.equal(gameServerBase(CFG), 'https://game.example.com');
    assert.equal(gameServerBase({ gameServer: { url: 'ws://127.0.0.1:8787' } }), 'http://127.0.0.1:8787');
    assert.equal(gameServerBase({ gameServer: { url: '' } }), '');
    assert.equal(gameServerBase({}), '');
    assert.equal(gameServerBase({ gameServer: { url: 'ftp://x' } }), '');
    assert.equal(gameServerWs('https://game.example.com'), 'wss://game.example.com');
  });

  test('주소가 없으면 서버에 묻지도 않고 방장 판정(지금 배포 값)', async () => {
    let asked = false;
    const eng = await chooseEngine({ cfg: { transport: 'relay', gameServer: { url: '' } }, search: '?server=1', fetch: async () => { asked = true; } });
    assert.equal(eng, 'host');
    assert.equal(asked, false);
    assert.equal(lastChoice().why, 'no_url');
  });

  test('비율대로: random < ratio면 서버', async () => {
    const f = answer({ ok: true, accepting: true, ratio: 0.1, protocol: 2 });
    assert.equal(await chooseEngine({ cfg: CFG, search: '', fetch: f, random: () => 0.05 }), 'server');
    assert.equal(answer.last, 'https://game.example.com/rollout');
    assert.equal(await chooseEngine({ cfg: CFG, search: '', fetch: f, random: () => 0.5 }), 'host');
    assert.equal(lastChoice().why, 'dice');
  });

  test('끄는 스위치(accepting:false·ratio 0)·닿지 않음·HTTP 오류·시간 초과는 방장 판정', async () => {
    assert.equal(await chooseEngine({ cfg: CFG, search: '?server=1', fetch: answer({ accepting: false, ratio: 0 }), random: () => 0 }), 'host');
    assert.equal(lastChoice().why, 'off');
    assert.equal(await chooseEngine({ cfg: CFG, search: '', fetch: async () => { throw new TypeError('Failed to fetch'); }, random: () => 0 }), 'host');
    assert.equal(lastChoice().why, 'unreachable');
    assert.equal(await chooseEngine({ cfg: CFG, search: '', fetch: answer({}, false), random: () => 0 }), 'host');
    const never = () => new Promise(() => {});
    const t0 = Date.now();
    assert.deepEqual(await fetchRollout('https://g.example', { fetch: never, timeoutMs: 50 }), { ok: false });
    assert.ok(Date.now() - t0 < 1000);
  });

  test('?server=0은 늘 방장, ?server=1·transport server는 서버가 받으면 비율과 상관없이 서버', async () => {
    const f = answer({ ok: true, accepting: true, ratio: 0.01 });
    assert.equal(await chooseEngine({ cfg: CFG, search: '?server=0', fetch: f, random: () => 0 }), 'host');
    assert.equal(await chooseEngine({ cfg: CFG, search: '?server=1', fetch: f, random: () => 0.99 }), 'server');
    assert.equal(await chooseEngine({ cfg: { ...CFG, transport: 'server' }, search: '', fetch: f, random: () => 0.99 }), 'server');
  });
});
