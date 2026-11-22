/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서울 게임 서버 배포 구성(infra/aws의 Terraform·user-data, game-server 스크립트·유닛, 배포 워크플로)의 핵심 약속을 글자로 시험한다.
 *          비밀 값이 파일에 없음, OIDC가 이 저장소의 game-server-v* 태그만 믿음, 건강 확인 뒤에 Caddy 전환·옛 프로세스 비우기,
 *          지표 수집기의 합치기·경보 기준. Terraform이 없는 PC에서도 돈다(terraform validate를 대신하지는 않는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvText, parsePrometheus, summarize, toMetricData, metricValue } from '../infra/aws/game-server/metrics-agent.mjs';
import { readSettings, renderSecretsEnv } from '../infra/aws/game-server/secrets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');
const AWS = 'infra/aws';
const GS = `${AWS}/game-server`;
const tfFiles = readdirSync(join(root, AWS)).filter((f) => f.endsWith('.tf')).map((f) => `${AWS}/${f}`);
const tfText = () => tfFiles.map(read).join('\n');
const scripts = readdirSync(join(root, GS)).filter((f) => /\.(sh|mjs)$/.test(f)).map((f) => `${GS}/${f}`);
const units = readdirSync(join(root, GS, 'systemd')).map((f) => `${GS}/systemd/${f}`);
const workflowFile = '.github/workflows/deploy-game-server.yml';
const deployFiles = [...tfFiles, `${AWS}/user-data.sh.tftpl`, ...scripts, ...units, workflowFile];

/** `resource "type" "name" {`부터 짝이 맞는 }까지 */
function block(text, header) {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `${header}가 없다`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${header}의 괄호가 닫히지 않는다`);
}
const variableDefault = (name) => {
  const m = block(read(`${AWS}/variables.tf`), `variable "${name}"`).match(/default\s*=\s*("(?:[^"\\]|\\.)*"|[^\n]+)/);
  return m && m[1].trim();
};

test('비밀 값·키가 배포 파일에 없고 Terraform은 비밀 값을 만들지 않는다', () => {
  const patterns = [/AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /aws_secret_access_key/i, /GAME_RESULT_SECRET\s*[=:]\s*['"]?[A-Za-z0-9+/]{8,}/];
  for (const file of deployFiles) {
    const text = read(file);
    for (const re of patterns) assert.ok(!re.test(text), `${file}에 비밀처럼 보이는 값: ${re}`);
  }
  assert.ok(!/resource\s+"aws_ssm_parameter"/.test(tfText()), 'SSM 비밀 값은 소유자가 CLI로 넣는다(Terraform 상태에 값이 남지 않게)');
  assert.ok(!/\bvalue\s*=\s*var\.secret/.test(tfText()));
  assert.ok(!/secrets\./.test(read(workflowFile)), '워크플로는 저장소 비밀(secrets.*) 없이 OIDC와 변수만 쓴다');
  assert.ok(!/GAME_RESULT_SECRET/.test(read(`${AWS}/user-data.sh.tftpl`)), 'user-data(콘솔에서 보인다)에 비밀 이름·값을 넣지 않는다');
  assert.equal(variableDefault('secret_names'), '["GAME_RESULT_SECRET"]');
});

test('user-data 템플릿의 ${이름}과 templatefile에 넘기는 값이 정확히 같다', () => {
  const tpl = read(`${AWS}/user-data.sh.tftpl`);
  const used = new Set([...tpl.matchAll(/(?<!\$)\$\{([a-z_]+)\}/g)].map((m) => m[1]));
  const call = read(`${AWS}/main.tf`).match(/templatefile\("\$\{path\.module\}\/user-data\.sh\.tftpl", \{([\s\S]*?)\n\s*\}\)/)[1];
  const passed = new Set([...call.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), [...passed].sort());
  assert.ok(!/\$\{[^}]*[^a-z_}][^}]*\}/.test(tpl.replace(/\$\$\{/g, '')), '템플릿 안 셸 변수는 $이름 또는 $${이름}으로 쓴다');
});

test('Terraform에서 쓰는 var.*는 모두 선언되어 있고 선언한 변수는 모두 쓴다', () => {
  const declared = new Set([...read(`${AWS}/variables.tf`).matchAll(/^variable "([a-z0-9_]+)"/gm)].map((m) => m[1]));
  const used = new Set([...tfText().matchAll(/\bvar\.([a-z0-9_]+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(declared.has(name), `var.${name}이 variables.tf에 없다`);
  for (const name of declared) assert.ok(used.has(name), `variable "${name}"을 쓰는 곳이 없다`);
  const locals = new Set([...tfText().matchAll(/^\s{2}([a-z0-9_]+)\s*=/gm)].map((m) => m[1]));
  for (const m of tfText().matchAll(/\blocal\.([a-z0-9_]+)/g)) assert.ok(locals.has(m[1]), `local.${m[1]}이 없다`);
});

test('OIDC 역할은 이 저장소의 game-server-v* 태그만 믿는다', () => {
  const role = block(read(`${AWS}/github-deploy.tf`), 'resource "aws_iam_role" "game_deploy"');
  assert.match(role, /"token\.actions\.githubusercontent\.com:aud" = "sts\.amazonaws\.com"/);
  const subs = [...role.matchAll(/"token\.actions\.githubusercontent\.com:sub" = "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(subs, ['repo:${var.github_repository}:ref:refs/tags/game-server-v*']);
  assert.match(role, /StringLike = \{\s*"token\.actions\.githubusercontent\.com:sub"/);
  for (const bad of ['refs/heads', 'pull_request', 'environment:', ':*"']) assert.ok(!role.includes(bad), `신뢰 조건에 ${bad}`);
  // 기본 저장소 이름이 서버가 받아 오는 저장소와 같다
  const repo = JSON.parse(variableDefault('github_repository'));
  assert.equal(JSON.parse(variableDefault('repo_url')), `https://github.com/${repo}.git`);
});

test('배포 역할은 이 서버에 배포 문서 하나만 보내고 결과는 읽기만 한다', () => {
  // 주석 줄은 빼고 실제 정책 글자만 본다
  const policy = block(read(`${AWS}/github-deploy.tf`), 'resource "aws_iam_role_policy" "game_deploy"').replace(/^\s*#.*$/gm, '');
  const actions = [...policy.matchAll(/Action\s*=\s*(\[[^\]]*\]|"[^"]*")/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['"ssm:SendCommand"', '["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:ListCommands"]']);
  assert.match(policy, /Action\s*=\s*"ssm:SendCommand"\s*\n\s*Resource\s*=\s*\[local\.instance_arn, aws_ssm_document\.deploy\.arn\]/);
  for (const bad of ['AWS-RunShellScript', 'ssm:*', '"*:*"', 'iam:', 'ec2:']) assert.ok(!policy.includes(bad), `배포 역할에 ${bad}`);
  assert.match(read(`${AWS}/github-deploy.tf`), /instance_arn\s*=\s*"arn:aws:ec2:\$\{local\.region\}:\$\{data\.aws_caller_identity\.current\.account_id\}:instance\/\$\{aws_instance\.game\.id\}"/);
});

test('배포 문서는 태그 이름만 받고 형식 검사가 셸 기호를 막는다', () => {
  const doc = block(read(`${AWS}/github-deploy.tf`), 'resource "aws_ssm_document" "deploy"');
  const pattern = doc.match(/allowedPattern = "([^"]+)"/)[1];
  const re = new RegExp(pattern);
  for (const ok of ['game-server-v1.0.0', 'game-server-v2026.11.23-rc1']) assert.ok(re.test(ok), ok);
  for (const bad of ['main', 'game-server-v1;reboot', 'game-server-v$(id)', "game-server-v1'", 'game-server-v 1', 'v1.0.0']) assert.ok(!re.test(bad), bad);
  // 워크플로의 이름 검사와 같은 형식
  assert.ok(read(workflowFile).includes(`grep -Eq '${pattern}'`));
  assert.match(doc, /bash \/opt\/fps\/src\/infra\/aws\/game-server\/deploy\.sh/);
  assert.match(doc, /rev-parse --verify \\"refs\/tags\/\$tag\^\{commit\}\\"/);
});

test('deploy.sh: 새 프로세스 → /healthz 확인 → Caddy 전환 → 옛 슬롯 비우기 순서이고 실패하면 옛 버전을 둔다', () => {
  const sh = read(`${GS}/deploy.sh`);
  const at = (needle) => {
    const i = sh.indexOf(needle);
    assert.ok(i >= 0, `deploy.sh에 ${needle}가 없다`);
    return i;
  };
  const order = ['systemctl restart fps-secrets.service', 'systemctl start "fps-game@$new$i.service"', 'fps_wait_healthy "$port"', 'caddy validate', 'systemctl reload caddy', 'echo "$new" > "$FPS_STATE_DIR/active-slot"', 'drain.sh" "$old"'];
  const idx = order.map(at);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, '순서가 어긋난다');
  // 건강 확인 실패 블록: 새 슬롯만 멈추고 Caddy를 건드리기 전에 끝난다
  const failBlock = sh.slice(at('if ! fps_wait_healthy'), at('새 프로세스 모두 건강함'));
  assert.match(failBlock, /fps_stop_slot "\$new"/);
  assert.match(failBlock, /die /);
  assert.ok(!/fps_stop_slot "\$old"/.test(sh), '옛 슬롯은 drain.sh만 멈춘다');
  assert.match(sh, /systemd-run --unit "fps-drain-\$old"/, '비우기는 SSM 명령이 끝나도 도는 별도 유닛');
  assert.match(sh, /flock --nonblock/);
  assert.match(sh, /workers=\$\(nproc\)/, '기본 프로세스 수 = vCPU 수');
});

test('Caddy: 같은 방은 같은 프로세스, 새 포트 건강 검사, 비우는 동안 옛 WebSocket 유지, /metrics 막기', () => {
  const sh = read(`${GS}/deploy.sh`);
  const caddy = sh.slice(sh.indexOf('cat > "$caddyfile.new"'), sh.indexOf('caddy validate'));
  assert.match(caddy, /lb_policy uri_hash/);
  assert.match(caddy, /health_uri \/healthz/);
  assert.match(caddy, /stream_close_delay \$\{close_delay\}s/);
  assert.match(caddy, /flush_interval -1/);
  assert.match(caddy, /handle \/metrics \{\s*respond 404/);
  assert.match(sh, /close_delay=\$\(\(\$\{FPS_DRAIN_MAX_SECONDS:-1800\} \+ 60\)\)/, '끊기 유예는 비우기 최대 시간보다 길어야 한다');
  assert.ok(!/read_body|write\s+\d/.test(caddy), '본문·쓰기 시간 제한은 WebSocket을 끊을 수 있어 넣지 않는다');
});

test('drain.sh: 접속 0이면 멈추고 최대 시간이 지나면 남은 것도 멈춘다', () => {
  const sh = read(`${GS}/drain.sh`);
  assert.match(sh, /fps_metric "\$port" skala_connections/);
  assert.match(sh, /deadline=\$\(\(\$\(date \+%s\) \+ max\)\)/);
  assert.match(sh, /max=\$\{FPS_DRAIN_MAX_SECONDS:-1800\}/);
  assert.match(sh.trimEnd(), /fps_stop_slot "\$slot"$/);
});

test('systemd 유닛: 비특권 계정, 실패 시 재시작, 비밀 값은 /run 파일로만, 비밀 재읽기가 게임을 재시작하지 않는다', () => {
  const game = read(`${GS}/systemd/fps-game@.service`);
  for (const line of ['User=fps', 'Restart=on-failure', 'EnvironmentFile=/run/fps/secrets.env', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'ExecStart=/usr/local/lib/fps/run-game.sh %i']) {
    assert.ok(game.split(/\r?\n/).includes(line), `fps-game@.service에 ${line}`);
  }
  assert.ok(!/^(Requires|BindsTo|PartOf)=.*fps-secrets/m.test(game));
  const secrets = read(`${GS}/systemd/fps-secrets.service`);
  assert.match(secrets, /^Type=oneshot$/m);
  assert.match(secrets, /secrets\.mjs \/run\/fps\/secrets\.env/);
  assert.match(read(`${GS}/systemd/fps-metrics.timer`), /^OnUnitActiveSec=60$/m);
  assert.match(read(`${GS}/systemd/fps-metrics.service`), /^DynamicUser=yes$/m);
  // 모든 슬롯 포트는 Caddy만 받는 127.0.0.1이고 보안 그룹은 80·443만 연다
  assert.match(variableDefault('service_command'), /--host 127\.0\.0\.1/);
  const sg = block(read(`${AWS}/main.tf`), 'resource "aws_security_group" "game"');
  assert.deepEqual([...sg.matchAll(/from_port\s*=\s*(\d+)/g)].map((m) => m[1]), ['80', '443', '0']);
});

test('user-data는 옛 중계 어댑터가 아니라 저장소의 deploy.sh로 게임 서버를 띄운다', () => {
  const tpl = read(`${AWS}/user-data.sh.tftpl`);
  assert.ok(!tpl.includes('server/relay'), '옛 relay 어댑터 경로가 남아 있다');
  assert.ok(!tpl.includes('fps.service'));
  assert.match(tpl, /bash \/opt\/fps\/src\/infra\/aws\/game-server\/deploy\.sh "\$sha" "\$ref"/);
  assert.match(tpl, /FPS_SECRET_PARAMETER_PATH=\$\{secret_parameter_path\}/);
  assert.match(variableDefault('service_command'), /^"\/usr\/local\/bin\/node server\/node\.js /);
  const runtime = block(read(`${AWS}/main.tf`), 'resource "aws_iam_role_policy" "game_runtime"');
  assert.match(runtime, /Resource = "\$\{local\.secret_arn_prefix\}\/\*"/);
  assert.match(runtime, /"cloudwatch:namespace" = local\.metrics_namespace/);
});

test('워크플로: 태그·수동 실행, 검사 먼저, OIDC, 변수 없으면 notice로 건너뜀, 명령 결과 확인', () => {
  const wf = read(workflowFile);
  assert.match(wf, /push:\s*\n\s*tags: \['game-server-v\*'\]/);
  assert.match(wf, /workflow_dispatch:/);
  assert.ok(!/branches:/.test(wf), '브랜치 push로는 배포하지 않는다');
  assert.match(wf, /permissions:\s*\n\s*contents: read\s*\n\s*id-token: write/);
  const check = wf.indexOf('run: npm run check');
  const assume = wf.indexOf('aws-actions/configure-aws-credentials');
  const send = wf.indexOf('aws ssm send-command');
  assert.ok(check > 0 && check < assume && assume < send, 'npm run check → 역할 맡기 → SSM 명령 순서');
  assert.match(wf, /::notice::Game server deployment skipped/);
  assert.match(wf, /role-to-assume: \$\{\{ vars\.AWS_GAME_DEPLOY_ROLE_ARN \}\}/);
  assert.match(wf, /get-command-invocation/);
  assert.match(wf, /\[ "\$status" != Success \]/);
  assert.match(wf, /github\.ref_type != 'tag'/);
  assert.match(wf, /cancel-in-progress: false/);
});

test('경보: 틱 p95가 5분 동안 33 ms 초과, /healthz 실패(값이 안 와도 실패)', () => {
  const main = read(`${AWS}/main.tf`);
  const tick = block(main, 'resource "aws_cloudwatch_metric_alarm" "tick_p95"');
  assert.match(tick, /metric_name\s*= "TickP95Ms"/);
  assert.match(tick, /period\s*= 60/);
  assert.match(tick, /evaluation_periods\s*= 5/);
  assert.match(tick, /datapoints_to_alarm = 5/);
  assert.match(tick, /threshold\s*= var\.tick_p95_alarm_ms/);
  assert.equal(variableDefault('tick_p95_alarm_ms'), '33');
  const health = block(main, 'resource "aws_cloudwatch_metric_alarm" "healthz"');
  assert.match(health, /metric_name\s*= "HealthCheckOk"/);
  assert.match(health, /comparison_operator = "LessThanThreshold"/);
  assert.match(health, /treat_missing_data = "breaching"/);
  // Terraform 이름공간·차원과 수집기 기본값이 같다
  assert.match(main, /metrics_namespace = "SkalaFps\/GameServer"/);
  assert.match(read(`${GS}/metrics-agent.mjs`), /FPS_METRICS_NAMESPACE \|\| 'SkalaFps\/GameServer'/);
  assert.match(read(`${AWS}/user-data.sh.tftpl`), /FPS_METRICS_SERVICE=\$\{metrics_service\}/);
});

const SAMPLE = `# HELP skala_rooms 열린 방 수
# TYPE skala_rooms gauge
skala_rooms 3
skala_players 11
skala_connections 12
skala_tick_ms{q="0.5"} 1.2
skala_tick_ms{q="0.95"} 4.75
skala_tick_ms{q="max"} 9
skala_tick_duration_ms_bucket{le="+Inf"} 100
`;

test('지표 수집기: Prometheus 글자를 읽고 프로세스 값을 합친다', () => {
  const samples = parsePrometheus(SAMPLE);
  assert.equal(metricValue(samples, 'skala_rooms'), 3);
  assert.equal(metricValue(samples, 'skala_tick_ms', { q: '0.95' }), 4.75);
  assert.equal(metricValue(samples, 'skala_tick_duration_ms_bucket', { le: '+Inf' }), 100);
  assert.equal(metricValue(samples, 'nope'), undefined);
  const slow = parsePrometheus('skala_rooms 1\nskala_players 2\nskala_connections 2\nskala_tick_ms{q="0.95"} 40\n');
  const s = summarize({ active: [{ healthy: true, samples }, { healthy: true, samples: slow }], draining: [{ samples: slow }, { samples: null }], caddyUp: true });
  assert.deepEqual(s, { Rooms: 5, Players: 15, Connections: 16, TickP95Ms: 40, HealthyProcesses: 2, ExpectedProcesses: 2, DrainingProcesses: 1, HealthCheckOk: 1 });
  assert.equal(summarize({ active: [{ healthy: true, samples }, { healthy: false, samples: null }], draining: [], caddyUp: true }).HealthCheckOk, 0);
  assert.equal(summarize({ active: [{ healthy: true, samples }], draining: [], caddyUp: false }).HealthCheckOk, 0, 'Caddy가 죽으면 바깥에서는 못 들어온다');
  const none = summarize({ active: [], draining: [], caddyUp: true });
  assert.equal(none.HealthCheckOk, 0, '받는 프로세스가 없으면 실패');
  assert.equal(none.TickP95Ms, undefined);
  const data = toMetricData(none, 'skala-fps-game');
  assert.ok(!data.some((d) => d.MetricName === 'TickP95Ms'), '값이 없으면 보내지 않는다(경보는 notBreaching)');
  const full = toMetricData(s, 'skala-fps-game');
  assert.deepEqual(full.find((d) => d.MetricName === 'TickP95Ms'), { MetricName: 'TickP95Ms', Dimensions: [{ Name: 'Service', Value: 'skala-fps-game' }], Unit: 'Milliseconds', Value: 40 });
  assert.equal(full.find((d) => d.MetricName === 'Rooms').Unit, 'Count');
  assert.deepEqual(parseEnvText('FPS_PORTS="8801 8802"\nFPS_REF=game-server-v1\n# x\n'), { FPS_PORTS: '8801 8802', FPS_REF: 'game-server-v1' });
});

test('비밀 값 파일: 이름 검사, 없는 값은 실패, 이상한 글자는 값을 드러내지 않고 실패', () => {
  const settings = readSettings({ FPS_SECRET_PARAMETER_PATH: '/skala-fps/game/', FPS_SECRET_NAMES: 'GAME_RESULT_SECRET' });
  assert.deepEqual(settings, { path: '/skala-fps/game', names: ['GAME_RESULT_SECRET'] });
  assert.deepEqual(readSettings({ FPS_SECRET_NAMES: '' }).names, []);
  assert.throws(() => readSettings({ FPS_SECRET_PARAMETER_PATH: '/p', FPS_SECRET_NAMES: 'lower' }), /대문자/);
  assert.throws(() => readSettings({ FPS_SECRET_PARAMETER_PATH: 'nope', FPS_SECRET_NAMES: 'A' }), /경로/);
  const hex = 'a'.repeat(64);
  const text = renderSecretsEnv(settings, { Parameters: [{ Name: '/skala-fps/game/GAME_RESULT_SECRET', Value: hex }], InvalidParameters: [] });
  assert.ok(text.split('\n').includes(`GAME_RESULT_SECRET='${hex}'`));
  assert.throws(() => renderSecretsEnv(settings, { Parameters: [], InvalidParameters: ['/skala-fps/game/GAME_RESULT_SECRET'] }), /GAME_RESULT_SECRET/);
  assert.throws(() => renderSecretsEnv(settings, { Parameters: [] }), /없는 값/);
  const leaked = "x'$(reboot)";
  assert.throws(() => renderSecretsEnv(settings, { Parameters: [{ Name: '/skala-fps/game/GAME_RESULT_SECRET', Value: leaked }] }), (err) => !err.message.includes(leaked));
  assert.equal(renderSecretsEnv(readSettings({}), { Parameters: [] }).split('\n').filter((l) => l && !l.startsWith('#')).length, 0);
});

test('SOP: 워크플로가 읽는 변수와 되돌리기(이전 태그 다시 배포)를 적어 둔다', () => {
  const sop = read('docs/GAME_SERVER_DEPLOY_SOP.md');
  const outputs = read(`${AWS}/outputs.tf`);
  for (const name of new Set([...read(workflowFile).matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))) {
    assert.ok(sop.includes(`gh variable set ${name} `), `SOP 4.5에 ${name}`);
    assert.ok(outputs.includes(name), `outputs.tf 설명에 ${name}`);
  }
  assert.match(sop, /gh workflow run deploy-game-server\.yml --ref game-server-v/);
  assert.match(sop, /## 8\. 되돌리기/);
  assert.match(sop, /--type SecureString/);
  assert.ok(sop.includes(JSON.parse(variableDefault('secret_parameter_path')) + '/GAME_RESULT_SECRET'));
});

test('셸 스크립트 문법(bash -n)', { skip: process.platform === 'win32' ? 'Windows의 bash는 WSL일 수 있어 건너뜀(CI·Linux에서 돈다)' : false }, () => {
  for (const file of scripts.filter((f) => f.endsWith('.sh'))) {
    const r = spawnSync('bash', ['-n', join(root, file)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
});
