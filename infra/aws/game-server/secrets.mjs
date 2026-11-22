/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: SSM Parameter Store에서 게임 서버 비밀 값을 읽어 systemd 환경 파일(NAME='값' 줄)로 쓴다. fps-secrets.service가 root로 부른다.
 *          읽을 이름: FPS_SECRET_PARAMETER_PATH/<이름>(이름 목록은 FPS_SECRET_NAMES, 공백 구분). 인스턴스 역할 자격 증명과 AWS CLI를 쓴다.
 *          값은 화면·로그에 찍지 않는다. 하나라도 없으면 파일을 바꾸지 않고 실패한다(옛 값으로 도는 게임은 그대로).
 */
import { execFile } from 'node:child_process';
import { realpathSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PATH_RE = /^\/[A-Za-z0-9_.\/-]{1,200}$/;
// systemd 환경 파일과 셸 어느 쪽에서 읽어도 뜻이 같은 글자만 받는다(hex·base64url 등). 따옴표·$·역슬래시·공백은 안 된다
const VALUE_RE = /^[A-Za-z0-9_.:+=\/@%,~-]{1,4096}$/;

/** 설정(환경 변수) → { path, names }. 잘못되면 이유를 담은 Error */
export function readSettings(env = process.env) {
  const path = String(env.FPS_SECRET_PARAMETER_PATH || '').replace(/\/+$/, '');
  const names = String(env.FPS_SECRET_NAMES || '').split(/\s+/).filter(Boolean);
  if (names.length && !PATH_RE.test(path)) throw new Error(`FPS_SECRET_PARAMETER_PATH는 /로 시작하는 경로여야 합니다: "${path}"`);
  for (const name of names) if (!NAME_RE.test(name)) throw new Error(`비밀 이름은 대문자·숫자·_만 씁니다: ${name}`);
  if (names.length > 10) throw new Error('비밀 이름은 10개까지입니다(SSM get-parameters 한 번의 한도)');
  if (new Set(names).size !== names.length) throw new Error('비밀 이름이 겹칩니다');
  return { path, names };
}

/**
 * get-parameters 응답 → 환경 파일 글자. 없는 값·허용하지 않는 글자가 있으면 Error(값은 메시지에 넣지 않는다)
 * @param {{path:string, names:string[]}} settings
 * @param {{Parameters?:{Name:string, Value:string}[], InvalidParameters?:string[]}} response
 */
export function renderSecretsEnv({ path, names }, response) {
  const missing = [...(response.InvalidParameters || [])];
  const byName = new Map((response.Parameters || []).map((p) => [p.Name, p.Value]));
  const lines = ['# fps-secrets.service가 SSM Parameter Store에서 만든 파일. 직접 고치지 말 것'];
  for (const name of names) {
    const full = `${path}/${name}`;
    if (!byName.has(full)) {
      if (!missing.includes(full)) missing.push(full);
      continue;
    }
    const value = String(byName.get(full));
    if (!VALUE_RE.test(value)) throw new Error(`${full}의 값에 쓸 수 없는 글자가 있습니다. openssl rand -hex 32 처럼 hex로 다시 만드세요`);
    lines.push(`${name}='${value}'`);
  }
  if (missing.length) throw new Error(`SSM Parameter Store에 없는 값: ${missing.join(', ')} (SOP의 "비밀 값 넣기" 참고)`);
  return lines.join('\n') + '\n';
}

async function fetchParameters({ path, names }, env) {
  const run = promisify(execFile);
  const args = ['ssm', 'get-parameters', '--with-decryption', '--output', 'json', '--names', ...names.map((n) => `${path}/${n}`)];
  if (env.AWS_REGION) args.push('--region', env.AWS_REGION);
  const { stdout } = await run('aws', args, { maxBuffer: 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

/** @returns {Promise<number>} 종료 코드 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const out = argv[0];
  if (!out) {
    console.error('사용법: node secrets.mjs <쓸 파일>');
    return 2;
  }
  try {
    const settings = readSettings(env);
    const response = settings.names.length ? await fetchParameters(settings, env) : { Parameters: [] };
    const text = renderSecretsEnv(settings, response);
    writeFileSync(`${out}.tmp`, text, { mode: 0o640 });
    renameSync(`${out}.tmp`, out);
    console.log(`비밀 값 ${settings.names.length}개를 ${out}에 썼습니다: ${settings.names.join(', ') || '(없음)'}`);
    return 0;
  } catch (err) {
    // AWS CLI 오류 문구에는 값이 들어가지 않는다. 응답 본문(stdout)은 찍지 않는다
    console.error(`비밀 값 읽기 실패: ${err.stderr ? String(err.stderr).trim() : err.message}`);
    return 1;
  }
}

function isRunDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
}

if (isRunDirectly()) process.exitCode = await main();
