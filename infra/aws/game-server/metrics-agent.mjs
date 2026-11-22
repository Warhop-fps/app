/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 안 지표 수집기. 게임 프로세스마다 /healthz·/metrics를 읽어 합친 값을 CloudWatch 사용자 지표로 한 번 올린다(fps-metrics.timer가 60초마다).
 *          올리는 값: Rooms·Players·Connections(합), TickP95Ms(프로세스 중 최댓값), HealthyProcesses·ExpectedProcesses·DrainingProcesses,
 *          HealthCheckOk(받는 슬롯의 모든 프로세스가 200이고 Caddy가 돌면 1, 아니면 0). 이름공간은 FPS_METRICS_NAMESPACE, 차원 Service=FPS_METRICS_SERVICE.
 *          AWS CLI(put-metric-data)와 인스턴스 역할을 쓰므로 키를 파일에 두지 않는다.
 */
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const STATE_DIR = '/etc/fps/state';

/** KEY=VALUE 줄(따옴표 선택) 파일을 읽는다. 없으면 빈 객체 */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readEnvFile(path) {
  try { return parseEnvText(readFileSync(path, 'utf8')); } catch { return {}; }
}

/** Prometheus 텍스트 → [{name, labels, value}] */
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels = {};
    if (m[3]) for (const pair of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]] = pair[2];
    const value = Number(m[4]);
    if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

/** 표본에서 이름·라벨이 맞는 첫 값. 없으면 undefined */
export function metricValue(samples, name, labels = {}) {
  const hit = samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
  return hit ? hit.value : undefined;
}

/**
 * 프로세스별 결과 → 올릴 값.
 * @param {{active:{healthy:boolean, samples:object[]|null}[], draining:{samples:object[]|null}[], caddyUp:boolean}} input
 */
export function summarize({ active, draining, caddyUp }) {
  const all = [...active, ...draining].filter((p) => p.samples);
  const sum = (name) => all.reduce((n, p) => n + (metricValue(p.samples, name) || 0), 0);
  const ticks = all.map((p) => metricValue(p.samples, 'skala_tick_ms', { q: '0.95' })).filter((v) => Number.isFinite(v));
  const healthy = active.filter((p) => p.healthy).length;
  return {
    Rooms: sum('skala_rooms'),
    Players: sum('skala_players'),
    Connections: sum('skala_connections'),
    TickP95Ms: ticks.length ? Math.max(...ticks) : undefined,
    HealthyProcesses: healthy,
    ExpectedProcesses: active.length,
    DrainingProcesses: draining.filter((p) => p.samples).length,
    HealthCheckOk: active.length > 0 && healthy === active.length && caddyUp ? 1 : 0
  };
}

const UNITS = { TickP95Ms: 'Milliseconds' };

/** 요약 → put-metric-data의 --metric-data JSON 배열. 값이 없는 지표는 뺀다 */
export function toMetricData(summary, service) {
  return Object.entries(summary)
    .filter(([, v]) => Number.isFinite(v))
    .map(([MetricName, Value]) => ({ MetricName, Dimensions: [{ Name: 'Service', Value: service }], Unit: UNITS[MetricName] || 'Count', Value }));
}

async function getText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return { ok: res.status === 200, text: await res.text() };
}

async function probe(port, withHealth) {
  let healthy = false;
  let samples = null;
  if (withHealth) {
    try { healthy = (await getText(`http://127.0.0.1:${port}/healthz`)).ok; } catch { healthy = false; }
  }
  try {
    const r = await getText(`http://127.0.0.1:${port}/metrics`);
    if (r.ok) samples = parsePrometheus(r.text);
  } catch { samples = null; }
  return { port, healthy, samples };
}

async function caddyActive() {
  try {
    await run('systemctl', ['is-active', '--quiet', 'caddy']);
    return true;
  } catch {
    return false;
  }
}

/** 받는 슬롯과 비우는 중인 슬롯의 포트 */
export function slotPorts(stateDir = STATE_DIR) {
  let activeSlot = '';
  try { activeSlot = readFileSync(`${stateDir}/active-slot`, 'utf8').trim(); } catch { activeSlot = ''; }
  const portsOf = (slot) => (readEnvFile(`${stateDir}/slot-${slot}.env`).FPS_PORTS || '').split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number);
  const other = activeSlot === 'a' ? 'b' : activeSlot === 'b' ? 'a' : '';
  return { active: activeSlot ? portsOf(activeSlot) : [], other: other ? portsOf(other) : [] };
}

/** @returns {Promise<number>} 종료 코드 */
export async function main(env = process.env) {
  const namespace = env.FPS_METRICS_NAMESPACE || 'SkalaFps/GameServer';
  const service = env.FPS_METRICS_SERVICE || 'skala-fps-game';
  const ports = slotPorts();
  const active = await Promise.all(ports.active.map((p) => probe(p, true)));
  // 비우는 중인 옛 프로세스는 응답할 때만 센다(이미 멈췄으면 samples가 null)
  const draining = await Promise.all(ports.other.map((p) => probe(p, false)));
  const summary = summarize({ active, draining, caddyUp: await caddyActive() });
  const args = ['cloudwatch', 'put-metric-data', '--namespace', namespace, '--metric-data', JSON.stringify(toMetricData(summary, service))];
  if (env.AWS_REGION) args.push('--region', env.AWS_REGION);
  try {
    await run('aws', args, { windowsHide: true });
  } catch (err) {
    console.error(`CloudWatch 올리기 실패: ${err.stderr ? String(err.stderr).trim() : err.message}`);
    return 1;
  }
  console.log(JSON.stringify(summary));
  return 0;
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
