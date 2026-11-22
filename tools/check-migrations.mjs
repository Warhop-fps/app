/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: supabase/migrations/의 번호 파일을 검사하고 supabase/schema.sql(전체 사본)을 만든다(npm run check:migrations).
 *          검사: 이름이 NNNN_이름.sql, 0001부터 빈 번호 없이 이어짐, 머리말 있음, 맨 끝 문장이 자기 번호를 fps_schema_migrations에 넣음,
 *          schema.sql이 마이그레이션을 이어 붙인 것과 같음. --write는 schema.sql을 다시 만든다. 절차는 docs/DB_MIGRATION_SOP.md.
 */
/**
 * 사용법
 *   node tools/check-migrations.mjs            검사만(실패하면 종료 코드 1)
 *   node tools/check-migrations.mjs --write    schema.sql을 마이그레이션에서 다시 만든 뒤 검사
 *   --root <폴더>                              저장소 대신 볼 폴더(테스트용). 그 안의 supabase/를 본다
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeader } from './check-headers.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
/** 번호를 적는 문장. 파일의 맨 끝 문장이 정확히 이 모양이어야 한다 */
export const recordLine = (version, name) =>
  `insert into public.fps_schema_migrations (version, name) values (${version}, '${name}') on conflict (version) do nothing;`;

const lf = (s) => String(s).replace(/\r\n/g, '\n');

/** 주석·빈 줄을 뺀 줄들 */
function codeLines(text) {
  return lf(text).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
}

/**
 * 마이그레이션 파일 목록(이름·내용)을 검사한다.
 * @param {{file:string, text:string}[]} files
 * @returns {{errors:string[], migrations:{version:number, name:string, file:string, text:string}[]}}
 */
export function checkMigrationFiles(files) {
  const errors = [];
  const migrations = [];
  for (const { file, text } of files) {
    const m = FILE_RE.exec(file);
    if (!m) {
      errors.push(`${file}: 이름이 NNNN_이름.sql 모양이 아닙니다(숫자 4자리, 소문자·숫자·밑줄)`);
      continue;
    }
    migrations.push({ version: Number(m[1]), name: m[2], file, text });
  }
  migrations.sort((a, b) => a.version - b.version || (a.file < b.file ? -1 : 1));
  let expected = 1;
  migrations.forEach((mig, i) => {
    if (i > 0 && mig.version === migrations[i - 1].version) {
      errors.push(`${mig.file}: 번호 ${mig.version}이(가) 두 파일에 있습니다`);
    } else {
      if (mig.version !== expected) errors.push(`${mig.file}: ${String(expected).padStart(4, '0')}번이 와야 합니다(0001부터 빈 번호 없이)`);
      expected = mig.version + 1;
    }
    for (const problem of parseHeader(mig.text, '.sql').errors) errors.push(`${mig.file}: ${problem}`);
    const lines = codeLines(mig.text);
    const want = recordLine(mig.version, mig.name);
    if (lines[lines.length - 1] !== want) errors.push(`${mig.file}: 맨 끝 문장이 자기 번호를 넣어야 합니다: ${want}`);
    const others = lines.filter((l) => /insert into public\.fps_schema_migrations\b/i.test(l) && l !== want);
    if (others.length) errors.push(`${mig.file}: 다른 번호를 넣는 문장이 있습니다: ${others[0]}`);
  });
  if (!migrations.length) errors.push('마이그레이션 파일이 하나도 없습니다');
  else if (!/create table if not exists public\.fps_schema_migrations \(/.test(lf(migrations[0].text))) {
    errors.push(`${migrations[0].file}: 첫 마이그레이션이 fps_schema_migrations 표를 만들어야 합니다`);
  }
  return { errors, migrations };
}

const SNAPSHOT_HEADER = [
  '-- Date: 06NOV2026',
  '-- Author: Minkyu Jung',
  '-- Purpose: 자동으로 만든 전체 스키마 사본. 직접 고치지 않는다. supabase/migrations/의 번호 파일을 순서대로 이어 붙였다.',
  '--          바꿀 때는 migrations/에 다음 번호 파일을 더하고 node tools/check-migrations.mjs --write 로 이 파일을 다시 만든다.',
  '--          이미 쓰는 서버에는 아직 실행하지 않은 번호 파일만 SQL Editor에서 실행한다(docs/DB_MIGRATION_SOP.md).',
  '--          새 Supabase 프로젝트는 이 파일 하나를 처음부터 끝까지 실행해도 된다. 여러 번 실행해도 안전하고 번호도 모두 적힌다.'
];

/** 마이그레이션(번호 순서)을 이어 붙인 schema.sql 내용. 줄바꿈은 LF */
export function buildSnapshot(migrations) {
  const parts = [SNAPSHOT_HEADER.join('\n'), ''];
  for (const mig of migrations) {
    parts.push(`-- ════════════════ supabase/migrations/${mig.file} ════════════════`);
    parts.push(lf(mig.text).replace(/\n+$/, ''));
    parts.push('');
  }
  return parts.join('\n');
}

function readMigrations(root) {
  const dir = join(root, 'supabase', 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ file: e.name, text: readFileSync(join(dir, e.name), 'utf8') }));
}

/** @returns {{ok:boolean, errors:string[], count:number, latest:number, wrote:boolean}} */
export function runCheck({ root = REPO_ROOT, write = false } = {}) {
  const { errors, migrations } = checkMigrationFiles(readMigrations(root));
  const snapshotPath = join(root, 'supabase', 'schema.sql');
  let wrote = false;
  if (!errors.length) {
    const want = buildSnapshot(migrations);
    const have = existsSync(snapshotPath) ? lf(readFileSync(snapshotPath, 'utf8')) : null;
    if (have !== want) {
      if (write) {
        writeFileSync(snapshotPath, want);
        wrote = true;
      } else {
        errors.push('supabase/schema.sql이 마이그레이션을 이어 붙인 것과 다릅니다. schema.sql을 직접 고쳤다면 그 내용을 새 번호 파일로 옮기고 '
          + 'node tools/check-migrations.mjs --write 를 실행하세요');
      }
    }
  }
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  return { ok: !errors.length, errors, count: migrations.length, latest, wrote };
}

/** @returns {number} 종료 코드 */
export function main(argv = process.argv.slice(2)) {
  let root = REPO_ROOT;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') write = true;
    else if (argv[i] === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`오류: 모르는 옵션입니다: ${argv[i]}`);
      return 1;
    }
  }
  const result = runCheck({ root, write });
  for (const e of result.errors) console.log(`  FAIL  ${e}`);
  if (result.wrote) console.log('  바꿈  supabase/schema.sql');
  console.log(result.ok
    ? `통과: 마이그레이션 ${result.count}개(마지막 번호 ${result.latest}), schema.sql 사본 일치`
    : `실패: 문제 ${result.errors.length}개`);
  return result.ok ? 0 : 1;
}

function isRunDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
}

if (isRunDirectly()) process.exitCode = main();
