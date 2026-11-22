/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 설정. 기본값 표와, 명령줄 인자(--port 등)·환경 변수(PORT, HOST, LOG_LEVEL, ALLOWED_ORIGINS)를 읽어 검사한 설정 객체를 만든다.
 */
import { parseArgs } from 'node:util';
import { MAP_CHOICES } from '../core/maps.js';

export const DEFAULTS = Object.freeze({
  host: '0.0.0.0',
  port: 8787,
  hz: 30,                   // 서버 틱(입력 하나 = 틱 하나)
  substeps: 2,              // 입력 하나를 나눠 돌리는 이동 횟수(1/60초씩, 브라우저 고정 틱과 같다)
  snapshotEvery: 1,         // 스냅샷 간격(틱)
  matchEvery: 15,           // 점수판 간격(틱, 0.5초)
  roomSize: 6,              // 팀전 방 정원
  ffaRoomSize: 16,          // 개인전 방 정원(중계 서버의 16인방과 같다)
  maxRooms: 50,
  maxRoomsPerIp: 4,         // 한 IP가 만든 열린 방 수(1인 방으로 방 수 상한을 채우지 못하게)
  maxConnections: 300,
  maxPerIp: 32,             // 한 IP의 동시 접속. 교실·사무실처럼 한 공인 IP 뒤에 여러 명이 있어도 넉넉하게
  maxFrameBytes: 4096,      // 이보다 큰 프레임은 ws가 1009로 끊는다
  maxMessageBytes: 512,     // 이보다 큰 메시지는 버린다(위반 점수)
  msgRate: 60,              // 초당 메시지(입력 30 + 여유)
  msgBurst: 90,             // 순간 몰림 허용
  strikeLimit: 20,          // 위반 점수가 이만큼 쌓이면 끊는다(초당 1점씩 준다)
  joinTimeoutMs: 5000,      // 접속 뒤 이 안에 join이 없으면 끊는다
  pingIntervalMs: 5000,     // WebSocket ping 간격. ping 뒤 간격의 80%가 지나도 pong이 없으면 끊는다
  statsIntervalMs: 60000,   // 이 간격마다 서버 한 줄 + 방마다 한 줄 통계 로그(틱 시간·초당 메시지)
  maxBufferedBytes: 262144, // 받는 쪽이 못 따라와 쌓인 보낼 데이터가 이보다 크면 끊는다
  maxRewindMs: 300,         // 지연 보정 되감기 상한
  historyTicks: 64,         // 지연 보정 기록 길이(약 2초)
  defaultMap: 'arena',
  defaultMode: 'team',
  defaultRuleset: 'classic',
  defaultKillTarget: null,  // 개인전 목표 킬(방장이 opts.killTarget을 주지 않았을 때). null이면 20
  matchRules: Object.freeze({}),   // createMatch 규칙 덮어쓰기(데모·시험의 짧은 라운드)
  allowedOrigins: Object.freeze([]), // 비어 있으면 Origin을 보지 않는다(개발). 운영은 사이트 주소만. Origin이 없는 요청(브라우저 밖)은 통과
  trustProxy: false,        // true면 X-Forwarded-For의 첫 주소를 접속 IP로 본다(Caddy 뒤에서만 켠다)
  logLevel: 'info',
  seed: null                // 난수 시드(재현용). null이면 시각에서
});

const USAGE = `사용법: node server/node.js [옵션]   방 주소: ws://<호스트>:<포트>/room/<방 id(소문자·숫자 1~16자)>
  --port <n>            포트 (기본 ${DEFAULTS.port}, 환경 변수 PORT. 0이면 빈 포트)
  --host <addr>         받을 주소 (기본 ${DEFAULTS.host}, 환경 변수 HOST. Caddy 뒤에서는 127.0.0.1)
  --hz <n>              서버 틱 (기본 ${DEFAULTS.hz})
  --room-size <n>       팀전 방 정원 (기본 ${DEFAULTS.roomSize})
  --ffa-room-size <n>   개인전 방 정원 (기본 ${DEFAULTS.ffaRoomSize})
  --kill-target <n>     개인전 목표 킬 기본값 5~20 (기본 20)
  --max-rooms <n>       방 수 상한 (기본 ${DEFAULTS.maxRooms})
  --max-rewind-ms <n>   되감기 상한 (기본 ${DEFAULTS.maxRewindMs}, 0이면 지연 보정 끔)
  --map <id>            새 방의 기본 맵 (기본 ${DEFAULTS.defaultMap}: ${MAP_CHOICES.join(', ')})
  --mode <team|ffa>     새 방의 기본 모드
  --ruleset <id>        새 방의 기본 규칙 (classic, knife, sniper)
  --origins <a,b>       허용할 Origin (환경 변수 ALLOWED_ORIGINS). 비우면 검사하지 않음, Origin이 없는 요청은 통과
  --trust-proxy         X-Forwarded-For를 믿는다 (프록시 뒤에서만)
  --log-level <lv>      trace, debug, info, warn, error, silent (환경 변수 LOG_LEVEL)
  --stats-sec <n>       통계 로그(서버 한 줄 + 방마다 한 줄) 간격 (기본 ${DEFAULTS.statsIntervalMs / 1000})
  --round-sec <n>       라운드 길이(초)      --loadout-sec <n>  무기 선택 시간(초)
  --round-end-sec <n>   라운드 결과 시간(초) --rounds-to-win <n> 선승 수
  --seed <n>            난수 시드`;

export { USAGE };

function int(name, v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: ${min}~${max} 사이의 정수여야 합니다 (받은 값: ${v})`);
  return n;
}
function seconds(name, v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}: ${min}~${max}초여야 합니다 (받은 값: ${v})`);
  return Math.round(n * 1000);
}

/**
 * 명령줄·환경 변수 → 설정. 잘못된 값이면 이유를 담은 Error를 던진다.
 * @returns {{config:object, help:boolean}}
 */
export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      port: { type: 'string' }, host: { type: 'string' }, hz: { type: 'string' },
      'room-size': { type: 'string' }, 'ffa-room-size': { type: 'string' }, 'kill-target': { type: 'string' }, 'max-rooms': { type: 'string' }, 'max-rewind-ms': { type: 'string' },
      map: { type: 'string' }, mode: { type: 'string' }, ruleset: { type: 'string' },
      origins: { type: 'string' }, 'trust-proxy': { type: 'boolean' }, 'log-level': { type: 'string' },
      'round-sec': { type: 'string' }, 'loadout-sec': { type: 'string' }, 'round-end-sec': { type: 'string' },
      'rounds-to-win': { type: 'string' }, seed: { type: 'string' }, 'stats-sec': { type: 'string' }, help: { type: 'boolean', short: 'h' }
    }
  });
  const c = { ...DEFAULTS, matchRules: { ...DEFAULTS.matchRules } };
  const port = values.port ?? env.PORT;
  if (port !== undefined) c.port = int('--port', port, 0, 65535);
  if (values.host ?? env.HOST) c.host = values.host ?? env.HOST;
  if (values.hz !== undefined) c.hz = int('--hz', values.hz, 10, 128);
  if (values['room-size'] !== undefined) c.roomSize = int('--room-size', values['room-size'], 2, 16);
  if (values['ffa-room-size'] !== undefined) c.ffaRoomSize = int('--ffa-room-size', values['ffa-room-size'], 2, 16);
  if (values['kill-target'] !== undefined) c.defaultKillTarget = int('--kill-target', values['kill-target'], 5, 20);
  if (values['max-rooms'] !== undefined) c.maxRooms = int('--max-rooms', values['max-rooms'], 1, 10000);
  if (values['max-rewind-ms'] !== undefined) c.maxRewindMs = int('--max-rewind-ms', values['max-rewind-ms'], 0, 1000);
  if (values.map !== undefined) {
    if (!MAP_CHOICES.includes(values.map)) throw new Error(`--map: ${MAP_CHOICES.join(', ')} 중 하나여야 합니다`);
    c.defaultMap = values.map;
  }
  if (values.mode !== undefined) {
    if (values.mode !== 'team' && values.mode !== 'ffa') throw new Error('--mode: team 또는 ffa');
    c.defaultMode = values.mode;
  }
  if (values.ruleset !== undefined) c.defaultRuleset = values.ruleset;
  const origins = values.origins ?? env.ALLOWED_ORIGINS;
  if (origins) c.allowedOrigins = origins.split(',').map((s) => s.trim()).filter(Boolean);
  if (values['trust-proxy']) c.trustProxy = true;
  const level = values['log-level'] ?? env.LOG_LEVEL;
  if (level) {
    if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(level)) throw new Error(`--log-level: 모르는 수준 ${level}`);
    c.logLevel = level;
  }
  if (values['round-sec'] !== undefined) c.matchRules.roundTimeMs = seconds('--round-sec', values['round-sec'], 5, 600);
  if (values['loadout-sec'] !== undefined) c.matchRules.loadoutMs = seconds('--loadout-sec', values['loadout-sec'], 0, 60);
  if (values['round-end-sec'] !== undefined) c.matchRules.roundEndMs = seconds('--round-end-sec', values['round-end-sec'], 0, 60);
  if (values['rounds-to-win'] !== undefined) {
    const n = int('--rounds-to-win', values['rounds-to-win'], 1, 9);
    c.matchRules.roundsToWin = n;
    c.matchRules.maxRounds = n * 2 - 1;
  }
  if (values.seed !== undefined) c.seed = int('--seed', values.seed, 0, 0xffffffff);
  if (values['stats-sec'] !== undefined) c.statsIntervalMs = seconds('--stats-sec', values['stats-sec'], 1, 3600);
  return { config: c, help: !!values.help };
}
