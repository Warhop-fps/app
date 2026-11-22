/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: CloudFront 응답 헤더·캐시 경로가 _headers와 어긋나지 않는지, S3 업로드 순서·IAM 범위·배포 워크플로 조건을 시험한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOUDFRONT_CSP_LIMIT, DEFAULT_CACHE, SECURITY_HEADERS, compareHeaders, immutablePaths, invalidationPaths, parseHeaders, readHeaders, securityHeaders, syncPlan
} from '../tools/aws-static.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');
const tf = () => read('infra/aws/static/main.tf');
const headersText = read('_headers');
const rules = readHeaders(root);

test('_headers를 경로 묶음으로 읽는다', () => {
  assert.deepEqual(rules.map((rule) => rule.path), ['/*', '/', '/*.html', '/privacy', '/fonts/*', '/assets/models/*', '/audio/*']);
  assert.equal(rules.find((rule) => rule.path === '/*.html').headers['Cache-Control'], 'no-cache');
  assert.throws(() => parseHeaders('  X-Orphan: 1'), /읽을 수 없는 줄/);
});

test('CloudFront 응답 헤더 정책은 _headers를 직접 읽어 값을 따로 적지 않는다', () => {
  const main = tf();
  const headersPath = main.match(/file\("\$\{path\.module\}\/([^"]+)"\)/)[1];
  assert.equal(resolve(root, 'infra/aws/static', headersPath), resolve(root, '_headers'), 'main.tf가 저장소 루트의 _headers를 읽어야 한다');
  // main.tf의 regex를 같은 식으로 돌려 _headers의 값이 나오는지 본다(Terraform이 없는 PC에서도 확인)
  const want = securityHeaders(rules);
  for (const name of ['Content-Security-Policy', 'Referrer-Policy', 'Permissions-Policy']) {
    const pattern = main.match(new RegExp(`regex\\("(${name}: \\(\\[\\^\\\\r\\\\n\\]\\+\\))"`));
    assert.ok(pattern, `${name}을 _headers에서 regex로 읽어야 한다`);
    assert.equal(headersText.match(new RegExp(`${name}: ([^\\r\\n]+)`))[1].trim(), want[name]);
  }
  assert.ok(!/content_security_policy\s*=\s*"/.test(main), 'CSP 문자열을 main.tf에 직접 적지 않는다');
  assert.match(main, /content_type_options \{\s*override = true/);
  assert.match(main, /header\s*= "Permissions-Policy"/);
  assert.ok(!/frame_options/.test(main), 'X-Frame-Options는 CrazyGames iframe을 막으므로 넣지 않는다');
});

test('_headers의 "/*" 묶음에 새 헤더가 생기면 CloudFront 쪽도 고치라고 알린다', () => {
  assert.deepEqual(Object.keys(securityHeaders(rules)).sort(), [...SECURITY_HEADERS].sort(), '_headers "/*"에 헤더를 더했다면 infra/aws/static/main.tf 응답 헤더 정책과 SECURITY_HEADERS에도 더하세요');
  assert.equal(securityHeaders(rules)['X-Content-Type-Options'], 'nosniff');
  const allowed = ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
  assert.ok(allowed.includes(securityHeaders(rules)['Referrer-Policy']), 'CloudFront가 받는 Referrer-Policy 값이어야 한다');
  const csp = securityHeaders(rules)['Content-Security-Policy'];
  assert.ok(csp.length <= CLOUDFRONT_CSP_LIMIT, `CSP가 CloudFront 한도 ${CLOUDFRONT_CSP_LIMIT}자를 넘는다: ${csp.length}`);
  assert.ok(csp.includes("frame-ancestors 'self' https://*.crazygames.com https://crazygames.com capacitor://app.crazygames.com"));
});

test('1년 캐시 경로는 _headers와 main.tf가 같다', () => {
  const list = tf().match(/immutable_paths\s*=\s*\[([^\]]*)\]/)[1].match(/"([^"]+)"/g).map((value) => value.slice(1, -1));
  assert.deepEqual(list, immutablePaths(rules));
  assert.deepEqual(immutablePaths(rules), ['/fonts/*', '/assets/models/*', '/audio/*']);
});

test('CloudFront 기본 설정: 비공개 S3·OAC·index.html·HTTP/3·TLS 1.2·한국 엣지', () => {
  const main = tf(), vars = read('infra/aws/static/variables.tf');
  for (const flag of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) assert.match(main, new RegExp(`${flag}\\s*= true`));
  assert.match(main, /status = "Enabled"/);
  assert.match(main, /origin_access_control_id = aws_cloudfront_origin_access_control\.site\.id/);
  assert.match(main, /"AWS:SourceArn" = aws_cloudfront_distribution\.site\.arn/);
  assert.match(main, /default_root_object = "index\.html"/);
  assert.match(main, /http_version\s*= "http2and3"/);
  assert.match(main, /"TLSv1\.2_2021"/);
  assert.match(main, /viewer_protocol_policy\s*= "redirect-to-https"/);
  assert.match(vars, /default\s*= "PriceClass_200"/);
  assert.match(main, /provider\s*= aws\.us_east_1/);
  assert.match(main, /count\s*= local\.site_domain != "" \? 1 : 0/);
});

test('배포 역할은 이 저장소 main 브랜치만 믿고 버킷·배포 하나에만 쓴다', () => {
  const deploy = read('infra/aws/static/github-deploy.tf'), vars = read('infra/aws/static/variables.tf');
  assert.match(deploy, /"token\.actions\.githubusercontent\.com:sub" = "repo:\$\{local\.github_repo\}:ref:refs\/heads\/main"/);
  assert.match(deploy, /"token\.actions\.githubusercontent\.com:aud" = "sts\.amazonaws\.com"/);
  assert.ok(!/StringLike/.test(deploy), '와일드카드 조건을 쓰지 않는다');
  const actions = [...deploy.matchAll(/Action\s*=\s*(\[[^\]]+\]|"[^"]+")/g)].map((m) => m[1]).join(' ');
  for (const action of actions.match(/"[^"]+"/g).map((value) => value.slice(1, -1))) {
    assert.ok(['sts:AssumeRoleWithWebIdentity', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject', 'cloudfront:CreateInvalidation', 'cloudfront:GetDistribution'].includes(action), action);
  }
  assert.ok(!/Resource\s*=\s*"\*"/.test(deploy), '모든 자원(*) 권한을 주지 않는다');
  assert.match(vars, /default\s*= "https:\/\/github\.com\/JungMK0720\/skala-fps\.git"/);
  assert.equal(read('infra/aws/variables.tf').match(/variable "repo_url"[\s\S]*?default\s*= "([^"]+)"/)[1], vars.match(/variable "repo_url"[\s\S]*?default\s*= "([^"]+)"/)[1], '게임 서버와 같은 저장소');
});

test('S3 업로드: 경로별 Cache-Control, HTML은 마지막, 지우기는 다 올린 뒤', () => {
  const dist = join('build', 'dist');
  const plan = syncPlan({ bucket: 'skala-fps-site-123', dist, rules, exists: () => true });
  const cacheOf = (step) => step[step.indexOf('--cache-control') + 1];
  const upload = plan.filter((step) => !step.includes('--delete')), remove = plan.filter((step) => step.includes('--delete'));
  assert.equal(upload.length, 5);
  assert.deepEqual(remove.map((step) => step.filter((arg) => arg !== '--delete')), upload, '지우기 단계는 같은 명령에 --delete만 더한다');
  assert.ok(plan.indexOf(remove[0]) > plan.indexOf(upload.at(-1)));
  for (const [index, folder] of ['fonts', 'assets/models', 'audio'].entries()) {
    assert.equal(upload[index][2], join(dist, folder));
    assert.equal(upload[index][3], `s3://skala-fps-site-123/${folder}`);
    assert.equal(cacheOf(upload[index]), 'public, max-age=31536000, immutable');
  }
  const rest = upload[3];
  for (const pattern of ['fonts/*', 'assets/models/*', 'audio/*', '*.html', '_headers', '.nojekyll']) assert.ok(rest.includes(pattern), pattern);
  assert.equal(cacheOf(rest), DEFAULT_CACHE);
  const html = upload[4];
  assert.deepEqual(html.slice(4, 8), ['--exclude', '*', '--include', '*.html']);
  assert.equal(cacheOf(html), 'no-cache');
  assert.equal(syncPlan({ bucket: 'b-site', dist, rules, exists: (path) => !path.endsWith('audio') }).length, 8, '없는 폴더는 건너뛴다');
  assert.throws(() => syncPlan({ bucket: 'Bad Bucket', dist, rules }), /버킷/);
});

test('HTML 캐시 비우기 경로와 실제 응답 헤더 비교', () => {
  assert.deepEqual(invalidationPaths(join(root, 'tests')).slice(0, 1), ['/']);
  const want = securityHeaders(rules);
  const good = Object.fromEntries(Object.entries(want).map(([name, value]) => [name.toLowerCase(), value]));
  assert.deepEqual(compareHeaders(good, rules), []);
  assert.match(compareHeaders({ ...good, 'content-security-policy': "default-src 'self'" }, rules).join('\n'), /Content-Security-Policy 다름/);
  assert.match(compareHeaders({ ...good, 'x-frame-options': 'DENY' }, rules).join('\n'), /X-Frame-Options/);
  const { 'permissions-policy': _, ...missing } = good;
  assert.match(compareHeaders(missing, rules).join('\n'), /Permissions-Policy 없음/);
});

test('배포 워크플로는 변수가 없으면 건너뛰고 Pages와 동시에 운영 배포하지 않는다', () => {
  const aws = read('.github/workflows/deploy-aws-static.yml'), pages = read('.github/workflows/deploy-pages.yml');
  for (const name of ['AWS_STATIC_BUCKET', 'AWS_STATIC_DISTRIBUTION_ID', 'AWS_DEPLOY_ROLE_ARN', 'AWS_STATIC_REGION']) assert.ok(aws.includes(`vars.${name}`), name);
  assert.match(aws, /::notice::AWS static deployment skipped/);
  assert.match(aws, /id-token: write/);
  assert.match(aws, /aws-actions\/configure-aws-credentials@v4/);
  assert.ok(!/secrets\./.test(aws), '비밀 키 없이 OIDC만 쓴다');
  assert.ok(!/^\s+environment:/m.test(aws), 'environment를 쓰면 OIDC sub가 main 브랜치 조건과 달라진다');
  const order = ['npm run check', 'node tools/build-site.mjs', 'check-headers --url "$SITE_URL" --before-deploy', 'aws-static.mjs sync', 'aws-static.mjs invalidate', 'check-headers --url "$SITE_URL" --tries'].map((text) => aws.indexOf(text));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), '검사 → 빌드 → 헤더 확인 → 업로드 → 캐시 비우기 → 헤더 확인 순서');
  assert.match(aws, /env\.BUCKET != '' && env\.PAGES_PROJECT != ''[\s\S]*?exit 1/);
  assert.match(pages, /env\.AWS_BUCKET != ''[\s\S]*?exit 1/);
});
