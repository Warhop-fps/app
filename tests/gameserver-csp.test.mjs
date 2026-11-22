/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버 주소와 CSP 시험. 주소가 있으면 index.html·_headers의 connect-src가 그 주소를 허용해야 하고(지금 저장소 값도 검사),
 *          tools/set-domain.mjs --game-server가 세 파일을 함께 켜고 끄며, 두 CSP가 같게 남는지 본다. 임시 사본에서만 바꾼다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentGameServer, parseArgs, setGameServer } from '../tools/set-domain.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['js/config.js', 'index.html', '_headers'];
const quiet = () => {};
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');
const metaCsp = (html) => html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const headerCsp = (h) => h.match(/Content-Security-Policy: ([^\r\n]+)/)[1];
const connect = (csp) => csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('connect-src ')).split(/\s+/).slice(1);
const withoutFrame = (csp) => csp.split(';').map((p) => p.trim()).filter((p) => !p.startsWith('frame-ancestors ')).join('; ');

function copyRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fps-gs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of FILES) cpSync(join(root, f), join(dir, f), { recursive: true });
  return dir;
}

describe('게임 서버 주소와 CSP', () => {
  test('저장소 값: 게임 서버 주소가 있으면 두 CSP의 connect-src가 그 주소(wss·https)를 허용한다', () => {
    const host = currentGameServer(read(root, 'js/config.js'));
    if (!host) return;   // 지금 배포 값은 비어 있다(꺼짐)
    for (const csp of [metaCsp(read(root, 'index.html')), headerCsp(read(root, '_headers'))]) {
      assert.ok(connect(csp).includes(`wss://${host}`), `wss://${host}`);
      assert.ok(connect(csp).includes(`https://${host}`), `https://${host}`);
    }
  });

  test('--game-server로 켜고 끄면 세 파일이 함께 바뀌고 두 CSP는 같게 남는다. 다시 실행해도 같다', (t) => {
    const dir = copyRepo(t);
    const r = setGameServer(dir, 'game.example.io', {}, quiet);
    assert.deepEqual(r.changed.sort(), ['_headers', 'index.html', 'js/config.js']);
    assert.equal(currentGameServer(read(dir, 'js/config.js')), 'game.example.io');
    assert.match(read(dir, 'js/config.js'), /gameServer: \{ url: 'wss:\/\/game\.example\.io' \}/);
    const meta = metaCsp(read(dir, 'index.html'));
    assert.ok(connect(meta).includes('wss://game.example.io') && connect(meta).includes('https://game.example.io'));
    assert.equal(withoutFrame(headerCsp(read(dir, '_headers'))), meta, 'index.html과 _headers의 CSP가 같다');
    assert.equal(setGameServer(dir, 'game.example.io', {}, quiet).changed.length, 0, '두 번 해도 같다');

    setGameServer(dir, 'game2.example.io', {}, quiet);
    const moved = connect(metaCsp(read(dir, 'index.html')));
    assert.ok(moved.includes('wss://game2.example.io'));
    assert.ok(!moved.includes('wss://game.example.io'), '옛 게임 서버 호스트는 뺀다');

    setGameServer(dir, 'off', {}, quiet);
    assert.equal(currentGameServer(read(dir, 'js/config.js')), null);
    assert.match(read(dir, 'js/config.js'), /gameServer: \{ url: '' \}/);
    assert.ok(!connect(metaCsp(read(dir, 'index.html'))).some((v) => v.includes('game2.example.io')));
    assert.equal(withoutFrame(headerCsp(read(dir, '_headers'))), metaCsp(read(dir, 'index.html')));
    // 끈 뒤의 CSP는 처음 저장소 값과 같다(원래 비어 있었으면)
    if (!currentGameServer(read(root, 'js/config.js'))) assert.equal(metaCsp(read(dir, 'index.html')), metaCsp(read(root, 'index.html')));
  });

  test('dry-run은 파일을 바꾸지 않고, 옵션은 검사한다', (t) => {
    const dir = copyRepo(t);
    const before = FILES.map((f) => read(dir, f));
    setGameServer(dir, 'game.example.io', { dryRun: true }, quiet);
    assert.deepEqual(FILES.map((f) => read(dir, f)), before);
    assert.deepEqual(parseArgs(['--game-server', 'Game.Example.IO', '--dry-run']), { gameServer: 'game.example.io', dryRun: true });
    assert.deepEqual(parseArgs(['--game-server', 'off']), { gameServer: 'off' });
    assert.throws(() => parseArgs(['--game-server']), /사용법/);
    assert.throws(() => parseArgs(['--game-server', 'wss://g.example.io']), /도메인/);
    assert.throws(() => parseArgs(['--game-server', 'g.example.io', '--domain', 'x.io']), /함께 쓸 수 없는/);
  });
});
