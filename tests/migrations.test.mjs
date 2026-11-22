/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 번호 마이그레이션 검사 도구(tools/check-migrations.mjs)와 저장소의 supabase/migrations/를 검증한다.
 *          번호가 0001부터 이어지는가, 파일마다 맨 끝에서 자기 번호를 넣는가, schema.sql이 마이그레이션을 이어 붙인 사본과 같은가.
 *          각 파일은 다시 실행해도 안전한 형태인가(create … if not exists, create or replace, 지우는 문장 없음).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, checkMigrationFiles, recordLine, runCheck } from '../tools/check-migrations.mjs';

const HEAD = '-- Date: 06NOV2026\n-- Author: Minkyu Jung\n-- Purpose: 시험용 마이그레이션\n\n';
const TABLE = 'create table if not exists public.fps_schema_migrations (\n  version int primary key\n);\n';
const mig = (n, name, body = '') => ({
  file: `${String(n).padStart(4, '0')}_${name}.sql`,
  text: `${HEAD}${n === 1 ? TABLE : ''}${body}${recordLine(n, name)}\n`
});

describe('checkMigrationFiles', () => {
  test('0001부터 이어지고 자기 번호를 넣으면 통과', () => {
    const { errors, migrations } = checkMigrationFiles([mig(2, 'events'), mig(1, 'baseline')]);
    assert.deepEqual(errors, []);
    assert.deepEqual(migrations.map((m) => m.version), [1, 2]);
  });

  test('빈 번호·겹친 번호·잘못된 이름을 잡는다', () => {
    assert.match(checkMigrationFiles([mig(1, 'baseline'), mig(3, 'late')]).errors.join('\n'), /0003_late\.sql: 0002번이 와야/);
    assert.match(checkMigrationFiles([mig(1, 'baseline'), mig(1, 'again')]).errors.join('\n'), /두 파일에/);
    assert.match(checkMigrationFiles([mig(1, 'baseline'), { file: '2_x.sql', text: '' }]).errors.join('\n'), /2_x\.sql: 이름이/);
    assert.match(checkMigrationFiles([mig(1, 'baseline'), { file: '0002_Events.sql', text: '' }]).errors.join('\n'), /이름이/);
    assert.match(checkMigrationFiles([]).errors.join('\n'), /하나도 없습니다/);
  });

  test('머리말이 없거나 번호 문장이 맨 끝이 아니거나 다르면 잡는다', () => {
    const noHead = { ...mig(1, 'baseline') };
    noHead.text = noHead.text.slice(HEAD.length);
    assert.match(checkMigrationFiles([noHead]).errors.join('\n'), /머리말이 없습니다/);

    const notLast = mig(1, 'baseline');
    notLast.text += 'select 1;\n';
    assert.match(checkMigrationFiles([notLast]).errors.join('\n'), /맨 끝 문장/);

    const wrongNo = { file: '0001_baseline.sql', text: `${HEAD}${TABLE}${recordLine(2, 'baseline')}\n` };
    assert.match(checkMigrationFiles([wrongNo]).errors.join('\n'), /맨 끝 문장/);

    const twice = mig(2, 'events', `${recordLine(1, 'baseline')}\n`);
    assert.match(checkMigrationFiles([mig(1, 'baseline'), twice]).errors.join('\n'), /다른 번호를 넣는/);
  });

  test('첫 파일이 번호 표를 만들어야 한다. 줄바꿈이 CRLF여도 된다', () => {
    const first = { file: '0001_baseline.sql', text: `${HEAD}${recordLine(1, 'baseline')}\n` };
    assert.match(checkMigrationFiles([first]).errors.join('\n'), /fps_schema_migrations 표를 만들어야/);
    const crlf = mig(1, 'baseline');
    crlf.text = crlf.text.replace(/\n/g, '\r\n');
    assert.deepEqual(checkMigrationFiles([crlf]).errors, []);
  });
});

describe('schema.sql 사본', () => {
  test('사본이 다르면 실패하고 --write로 다시 만들면 통과한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'skala-mig-'));
    try {
      mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
      for (const m of [mig(1, 'baseline'), mig(2, 'events')]) writeFileSync(join(root, 'supabase', 'migrations', m.file), m.text);
      writeFileSync(join(root, 'supabase', 'schema.sql'), '-- 손으로 고친 옛 파일\n');
      const bad = runCheck({ root });
      assert.equal(bad.ok, false);
      assert.match(bad.errors.join('\n'), /schema\.sql이 마이그레이션을 이어 붙인 것과 다릅니다/);
      const fixed = runCheck({ root, write: true });
      assert.equal(fixed.ok, true);
      assert.equal(fixed.wrote, true);
      assert.equal(fixed.latest, 2);
      const again = runCheck({ root });
      assert.equal(again.ok, true);
      assert.equal(again.wrote, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('사본은 머리말 다음에 번호 순서로 파일을 담는다', () => {
    const out = buildSnapshot([mig(1, 'baseline'), mig(2, 'events')].map((m, i) => ({ ...m, version: i + 1 })));
    assert.match(out, /^-- Date: 06NOV2026\n-- Author: Minkyu Jung\n-- Purpose: 자동으로 만든/);
    assert.ok(out.indexOf('0001_baseline.sql') < out.indexOf('0002_events.sql'));
    assert.ok(out.includes(recordLine(1, 'baseline')) && out.includes(recordLine(2, 'events')));
  });
});

describe('저장소의 supabase/migrations', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = readdirSync(dir).sort();
  const code = (f) => readFileSync(new URL(f, dir), 'utf8').split(/\r?\n/).filter((l) => !l.trimStart().startsWith('--')).join('\n');

  test('검사를 통과하고 schema.sql 사본이 맞다', () => {
    const result = runCheck();
    assert.deepEqual(result.errors, []);
    assert.equal(result.count, files.length);
    assert.equal(files[0], '0001_baseline.sql');
  });

  test('파일마다 다시 실행해도 안전한 형태다', () => {
    for (const f of files) {
      const c = code(f);
      assert.ok(!/create\s+table\s+(?!if not exists)/i.test(c), f);
      assert.ok(!/create\s+function/i.test(c), `${f}: 함수는 create or replace만 쓴다`);
      assert.ok(!/create\s+(unique\s+)?index\s+(?!if not exists)/i.test(c), f);
      assert.ok(!/\b(truncate|delete from)\b/i.test(c), f);
      assert.ok(!/\bdrop\s+(?!function if exists )/i.test(c), f);
    }
  });

  test('번호 표는 브라우저가 직접 못 읽는다', () => {
    const c = code('0001_baseline.sql');
    assert.match(c, /alter table public\.fps_schema_migrations enable row level security;/);
    assert.match(c, /revoke all on public\.fps_schema_migrations from public, anon, authenticated;/);
  });
});
