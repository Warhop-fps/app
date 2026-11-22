/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 판정 방 비율과 끄는 스위치(node/rollout.js, GET /rollout) 시험. 파일을 고치면 다시 띄우지 않고 답이 바뀌는지,
 *          깨진 파일·없는 파일, CORS, welcome.paid(서버가 포인트를 넣는가)를 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRollout, parseRollout } from '../node/rollout.js';
import { loadConfig } from '../node/config.js';
import { createFakeClient } from '../tools/fake-client.js';
import { silentLog, startTestServer } from './helpers.mjs';

describe('rollout 파일', () => {
  test('모양 검사: ratio는 0~1로 자르고 accepting이 없으면 true', () => {
    assert.deepEqual(parseRollout('{"ratio":0.5}'), { ok: true, ratio: 0.5, accepting: true });
    assert.deepEqual(parseRollout('{"ratio":3,"accepting":false}'), { ok: true, ratio: 1, accepting: false });
    assert.equal(parseRollout('{"ratio":"0.5"}').ok, false);
    assert.equal(parseRollout('nope').ok, false);
    assert.equal(parseRollout('[1]').ok, false);
  });

  test('파일을 고치면 다시 읽고, 깨진 파일은 마지막 값을 쓰고, 없으면 설정값', () => {
    const files = new Map();
    const read = (p) => { if (!files.has(p)) { const e = new Error('no'); e.code = 'ENOENT'; throw e; } return files.get(p); };
    const ro = createRollout({ ratio: 0.2, file: 'r.json', log: silentLog(), read, everyMs: 60000 });
    assert.deepEqual(ro.current(), { ratio: 0.2, accepting: true, source: 'config' });
    files.set('r.json', '{"ratio":0.5}');
    ro.reload();
    assert.deepEqual(ro.current(), { ratio: 0.5, accepting: true, source: 'file' });
    files.set('r.json', '{"ratio":0.5,');
    ro.reload();
    assert.equal(ro.current().ratio, 0.5, '깨진 파일은 무시');
    files.set('r.json', '{"ratio":0.5,"accepting":false}');
    ro.reload();
    assert.equal(ro.current().accepting, false, '끄는 스위치');
    files.delete('r.json');
    ro.reload();
    assert.equal(ro.current().source, 'config');
    ro.close();
  });

  test('명령줄·환경 변수', () => {
    assert.equal(loadConfig([], {}).config.serverRatio, 0, '기본은 끔');
    assert.equal(loadConfig(['--server-ratio', '0.1'], {}).config.serverRatio, 0.1);
    assert.equal(loadConfig([], { SERVER_ROOM_RATIO: '1', ROLLOUT_FILE: '/x/r.json' }).config.rolloutFile, '/x/r.json');
    assert.throws(() => loadConfig(['--server-ratio', '2'], {}), /0~1/);
    const env = { GAME_RESULT_URL: 'https://a/v1/match-result', GAME_RESULT_SECRET: 'x'.repeat(40), GAME_SERVER_ID: 'ec2-a:1' };
    const c = loadConfig([], env).config;
    assert.equal(c.resultUrl, env.GAME_RESULT_URL);
    assert.equal(c.serverId, 'ec2-a:1');
    assert.throws(() => loadConfig([], { GAME_SERVER_ID: 'bad id!' }), /GAME_SERVER_ID/);
  });
});

describe('GET /rollout (소켓)', () => {
  test('비율·받는지·CORS. 파일로 끄면 accepting:false, ratio 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skala-rollout-'));
    const file = join(dir, 'rollout.json');
    writeFileSync(file, '{"ratio":0.25}');
    const server = await startTestServer({ serverRatio: 0, rolloutFile: file });
    try {
      let res = await fetch(`${server.httpUrl}/rollout`);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      let body = await res.json();
      assert.equal(body.accepting, true);
      assert.equal(body.ratio, 0.25);
      assert.equal(body.protocol, 2);
      writeFileSync(file, '{"ratio":0.25,"accepting":false}');
      // 5초 주기를 기다리지 않고 바로 다시 읽는 길은 없으므로, 주기 안에 바뀌는지 본다
      const t0 = Date.now();
      do {
        await new Promise((r) => setTimeout(r, 250));
        body = await (await fetch(`${server.httpUrl}/rollout`)).json();
      } while (body.accepting && Date.now() - t0 < 8000);
      assert.equal(body.accepting, false);
      assert.equal(body.ratio, 0);
      assert.equal(body.why, 'off');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('설정 비율 0(기본)이면 받지 않는다', async () => {
    const server = await startTestServer();
    try {
      const body = await (await fetch(`${server.httpUrl}/rollout`)).json();
      assert.deepEqual([body.accepting, body.ratio, body.why], [false, 0, 'off']);
    } finally { await server.close(); }
  });

  test('welcome.paid: 결과를 보내는 서버 + 토큰 해시가 있는 사람만 true', async () => {
    const fetchOk = async () => ({ status: 200, json: async () => ({ ok: true }) });
    const on = await startTestServer({ resultUrl: 'https://api.test/v1/match-result', resultSecret: 'x'.repeat(40), fetch: fetchOk });
    const off = await startTestServer();
    const clients = [];
    try {
      const mk = (server, tokenHash) => {
        let welcome = null;
        const c = createFakeClient({ url: server.url, room: 'paid1', behavior: 'idle', opts: { mode: 'ffa' }, tokenHash, onRaw: (t) => { if (!welcome && t.startsWith('{"t":"welcome"')) welcome = JSON.parse(t); } });
        clients.push(c);
        return c.ready.then(() => welcome);
      };
      assert.equal((await mk(on, 'a'.repeat(64))).paid, true);
      assert.equal((await mk(on, undefined)).paid, false, '손님');
      assert.equal((await mk(off, 'b'.repeat(64))).paid, false, '결과를 보내지 않는 서버');
    } finally {
      for (const c of clients) c.close();
      await on.close();
      await off.close();
    }
  });
});
