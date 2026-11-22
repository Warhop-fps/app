/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: _headers를 읽어 S3 업로드(경로별 Cache-Control)·CloudFront 캐시 비우기·실제 응답 헤더 확인을 한다(deploy-aws-static.yml).
 */
/**
 * 사용법 (저장소 루트, 먼저 node tools/build-site.mjs)
 *   node tools/aws-static.mjs plan --bucket <버킷>                 실행할 aws 명령만 출력(아무것도 올리지 않음)
 *   node tools/aws-static.mjs sync --bucket <버킷>                 dist/를 S3에 올리고 dist에 없는 파일을 지운다
 *   node tools/aws-static.mjs invalidate --distribution <ID>        HTML 캐시를 비운다
 *   node tools/aws-static.mjs check-headers --url https://<주소>/ [--before-deploy] [--tries 6]
 *        실제 응답 헤더가 _headers와 같은지 본다. 다르면 종료 코드 1(infra/aws/static을 다시 apply해야 함).
 *        --before-deploy: 사이트가 아직 비어 있어(첫 배포) 헤더가 없으면 통과로 본다.
 *
 * 헤더 값은 _headers 한 곳에만 둔다. CloudFront 응답 헤더 정책(infra/aws/static/main.tf)도 같은 파일을 읽는다.
 * 업로드 순서: 폰트·모델·음원 → js·css → HTML(새 HTML이 아직 없는 파일을 가리키지 않게). 지우기는 모두 올린 뒤에 한다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** _headers에 경로 규칙이 없는 파일(js·css 등). Cloudflare Pages 기본값과 같다: 매번 바뀌었는지 확인 */
export const DEFAULT_CACHE = 'public, max-age=0, must-revalidate';
/** Pages 전용 파일. S3에는 올리지 않는다 */
export const NOT_UPLOADED = Object.freeze(['_headers', '.nojekyll']);
/** CloudFront 응답 헤더 정책이 붙이는 헤더(_headers의 "/*" 묶음과 같아야 한다) */
export const SECURITY_HEADERS = Object.freeze(['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']);
/** CloudFront 응답 헤더 정책의 CSP 길이 한도(문자) */
export const CLOUDFRONT_CSP_LIMIT = 1783;

/**
 * _headers를 [{ path, headers: { 이름: 값 } }]로 읽는다. # 줄과 빈 줄은 건너뛴다.
 * @param {string} text
 */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { rules.push({ path: raw.trim(), headers: {} }); continue; }
    const at = raw.indexOf(':');
    if (at < 0 || !rules.length) throw new Error('_headers에서 읽을 수 없는 줄: ' + raw);
    rules[rules.length - 1].headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  }
  return rules;
}

export function readHeaders(root = ROOT) {
  return parseHeaders(readFileSync(resolve(root, '_headers'), 'utf8'));
}

/** 모든 경로("/*")에 붙는 보안 헤더 */
export function securityHeaders(rules) {
  const all = rules.find((rule) => rule.path === '/*');
  if (!all) throw new Error('_headers에 "/*" 묶음이 없습니다');
  return all.headers;
}

/** Cache-Control이 immutable인 폴더 경로("/fonts/*" 꼴) */
export function immutablePaths(rules) {
  return rules.filter((rule) => /\bimmutable\b/.test(rule.headers['Cache-Control'] || '')).map((rule) => rule.path);
}

function cacheFor(rules, path) {
  const rule = rules.find((r) => r.path === path && r.headers['Cache-Control']);
  if (!rule) throw new Error(`_headers에 ${path}의 Cache-Control이 없습니다`);
  return rule.headers['Cache-Control'];
}

/**
 * aws CLI 인자 목록을 만든다. 실행하지 않는다.
 * @param {{ bucket: string, dist: string, rules: ReturnType<typeof parseHeaders>, exists?: (path: string) => boolean }} opt
 * @returns {string[][]}
 */
export function syncPlan({ bucket, dist, rules, exists = existsSync }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '')) throw new Error('S3 버킷 이름이 올바르지 않습니다: ' + bucket);
  const target = `s3://${bucket}`;
  const quiet = ['--only-show-errors', '--no-progress'];
  const folders = immutablePaths(rules).map((path) => {
    if (!/^\/[A-Za-z0-9_./-]+\/\*$/.test(path)) throw new Error('폴더("/이름/*")가 아닌 immutable 경로는 지원하지 않습니다: ' + path);
    return { folder: path.slice(1, -2), cache: cacheFor(rules, path) };
  });
  const html = cacheFor(rules, '/*.html');
  const steps = [];
  for (const { folder, cache } of folders) {
    if (!exists(join(dist, folder))) continue;
    steps.push(['s3', 'sync', join(dist, folder), `${target}/${folder}`, '--cache-control', cache]);
  }
  const skip = [...folders.map(({ folder }) => `${folder}/*`), '*.html', ...NOT_UPLOADED].flatMap((pattern) => ['--exclude', pattern]);
  steps.push(['s3', 'sync', dist, target, ...skip, '--cache-control', DEFAULT_CACHE]);
  steps.push(['s3', 'sync', dist, target, '--exclude', '*', '--include', '*.html', '--cache-control', html]);
  // 1단계: 새 파일만 올린다. 2단계: 같은 명령에 --delete. 이미 올린 파일은 다시 올리지 않고 dist에 없는 것만 지운다.
  return [...steps.map((step) => [...step, ...quiet]), ...steps.map((step) => [...step, ...quiet, '--delete'])];
}

/** 캐시를 비울 HTML 경로. 루트(/)와 dist의 모든 .html */
export function invalidationPaths(dist) {
  const out = ['/'];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else if (name.endsWith('.html')) out.push(`/${prefix}${name}`);
    }
  };
  walk(dist, '');
  return out;
}

/**
 * 응답 헤더(소문자 이름)를 _headers와 비교해 다른 점을 돌려준다. 빈 배열이면 같다.
 * @param {Record<string, string>} got
 * @param {ReturnType<typeof parseHeaders>} rules
 */
export function compareHeaders(got, rules) {
  const want = securityHeaders(rules);
  const problems = [];
  for (const name of SECURITY_HEADERS) {
    const value = got[name.toLowerCase()];
    if (value === undefined) problems.push(`${name} 없음`);
    else if (value.trim() !== want[name]) problems.push(`${name} 다름\n  받은 값: ${value}\n  _headers: ${want[name]}`);
  }
  if (got['x-frame-options'] !== undefined) problems.push('X-Frame-Options가 있음(CrazyGames iframe을 막는다)');
  return problems;
}

function parseArgs(args) {
  const out = { command: args[0] };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === '--before-deploy') out.beforeDeploy = true;
    else if (['--bucket', '--dist', '--distribution', '--url', '--tries', '--wait'].includes(key)) out[key.slice(2)] = args[++i];
    else throw new Error('모르는 옵션: ' + key);
  }
  return out;
}

const say = (level, text) => console.log(process.env.GITHUB_ACTIONS ? `::${level}::${text.replace(/\n/g, '%0A')}` : `[${level}] ${text}`);
const aws = (args) => execFileSync('aws', args, { stdio: 'inherit' });

async function checkHeaders({ url, beforeDeploy, tries = '1', wait = '10' }) {
  if (!/^https:\/\/[^\s/]+\/?$/.test(url || '')) throw new Error('--url https://<주소>/ 가 필요합니다');
  const rules = readHeaders();
  let problems = [];
  for (let attempt = 1; attempt <= Number(tries); attempt++) {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const got = Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value]));
    if (beforeDeploy && got['content-security-policy'] === undefined && response.status >= 400) {
      say('notice', `${url} 응답 ${response.status}, 보안 헤더 없음: 아직 비어 있는 사이트(첫 배포)로 보고 계속합니다.`);
      return 0;
    }
    problems = compareHeaders(got, rules);
    if (!beforeDeploy && response.status !== 200) problems.push(`응답 코드 ${response.status} (200이어야 함)`);
    if (!beforeDeploy && !/no-cache/.test(got['cache-control'] || '')) problems.push(`첫 화면 Cache-Control이 no-cache가 아님: ${got['cache-control'] || '(없음)'}`);
    if (!problems.length) { say('notice', `${url} 응답 헤더가 _headers와 같습니다.`); return 0; }
    if (attempt < Number(tries)) await new Promise((done) => setTimeout(done, Number(wait) * 1000));
  }
  say('error', `${url} 응답 헤더가 _headers와 다릅니다. infra/aws/static에서 terraform apply를 다시 하세요(docs/AWS_STATIC_SOP.md 7절).\n${problems.join('\n')}`);
  return 1;
}

async function main(argv) {
  const opt = parseArgs(argv);
  const dist = resolve(ROOT, opt.dist || 'dist');
  if (opt.command === 'plan' || opt.command === 'sync') {
    if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist}에 index.html이 없습니다. 먼저 node tools/build-site.mjs`);
    const plan = syncPlan({ bucket: opt.bucket, dist, rules: readHeaders() });
    for (const args of plan) {
      console.log('aws ' + args.map((arg) => (/[\s*,]/.test(arg) ? `"${arg}"` : arg)).join(' '));
      if (opt.command === 'sync') aws(args);
    }
    return 0;
  }
  if (opt.command === 'invalidate') {
    if (!/^[A-Z0-9]{8,20}$/.test(opt.distribution || '')) throw new Error('--distribution <CloudFront 배포 ID>가 필요합니다');
    const paths = invalidationPaths(dist);
    console.log('캐시 비우기: ' + paths.join(' '));
    aws(['cloudfront', 'create-invalidation', '--distribution-id', opt.distribution, '--paths', ...paths, '--query', 'Invalidation.Id', '--output', 'text']);
    return 0;
  }
  if (opt.command === 'check-headers') return checkHeaders(opt);
  throw new Error('명령: plan | sync | invalidate | check-headers (파일 맨 위 사용법 참고)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}
